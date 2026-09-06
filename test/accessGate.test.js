/**
 * WHAT:
 * accessGate tests the three code groups, signed-token boundary, Quick Fill
 * restrictions, failed-attempt limit, and unchanged normal login route.
 * WHY:
 * Pre-login account privacy depends on server enforcement rather than Flutter
 * visibility, and access codes must never leak through responses or logs.
 * HOW:
 * Run the real Express routes with synthetic bcrypt hashes, exercise direct
 * service limits, and temporarily stub only database-dependent happy paths.
 */
const assert = require("node:assert/strict");
const { after, afterEach, before, test } = require("node:test");

const bcrypt = require("bcryptjs");

const app = require("../src/app");
const accessGateService = require("../src/services/accessGate.service");
const authService = require("../src/services/auth.service");

const SYNTHETIC_CODES = Object.freeze({
  student: "TEST-STUDENT-CODE",
  staff: "TEST-STAFF-CODE",
  management: "TEST-MANAGEMENT-CODE",
});

let server;
let baseUrl;

async function request(path, { method = "GET", body, gateToken } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(gateToken ? { "X-School-Access-Token": gateToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    response,
    json: await response.json(),
  };
}

async function verify(group) {
  return request("/api/auth/access-gate/verify", {
    method: "POST",
    body: { code: SYNTHETIC_CODES[group] },
  });
}

before(async () => {
  process.env.JWT_SECRET = "synthetic-access-gate-test-secret";
  process.env.FOCUS_MISSION_STUDENT_ACCESS_CODE_HASH = await bcrypt.hash(
    SYNTHETIC_CODES.student,
    4,
  );
  process.env.FOCUS_MISSION_STAFF_ACCESS_CODE_HASH = await bcrypt.hash(
    SYNTHETIC_CODES.staff,
    4,
  );
  process.env.FOCUS_MISSION_MANAGEMENT_ACCESS_CODE_HASH = await bcrypt.hash(
    SYNTHETIC_CODES.management,
    4,
  );
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  accessGateService.resetRateLimitForTests();
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

for (const group of ["student", "staff", "management"]) {
  test(`${group} code returns only a signed ${group} gate grant`, async () => {
    const { response, json } = await verify(group);

    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.accessGroup, group);
    assert.equal(typeof json.gateToken, "string");
    assert.ok(json.gateToken.length > 20);
    assert.ok(Date.parse(json.expiresAt) > Date.now());
    const responseText = JSON.stringify(json);
    assert.equal(responseText.includes(SYNTHETIC_CODES[group]), false);
    assert.equal(responseText.includes(process.env[
      `FOCUS_MISSION_${group.toUpperCase()}_ACCESS_CODE_HASH`
    ]), false);
  });
}

test("wrong code is rejected with one generic response", async () => {
  const { response, json } = await request("/api/auth/access-gate/verify", {
    method: "POST",
    body: { code: "SYNTHETIC-WRONG-CODE" },
  });

  assert.equal(response.status, 401);
  assert.equal(json.message, "That access code wasn't recognised.");
  assert.deepEqual(Object.keys(json).sort(), ["message", "statusCode"]);
});

test("missing and malformed code payloads are rejected", async () => {
  const missing = await request("/api/auth/access-gate/verify", {
    method: "POST",
    body: {},
  });
  const malformed = await request("/api/auth/access-gate/verify", {
    method: "POST",
    body: { code: { unexpected: true } },
  });

  assert.equal(missing.response.status, 422);
  assert.equal(malformed.response.status, 422);
});

test("submitted codes are never passed to console logging", async () => {
  const submittedCode = "SYNTHETIC-DO-NOT-LOG";
  const captured = [];
  const originals = {};
  for (const method of ["log", "info", "warn", "error"]) {
    originals[method] = console[method];
    console[method] = (...args) => captured.push(args);
  }

  try {
    await assert.rejects(
      accessGateService.verifyAccessCode({
        code: submittedCode,
        clientKey: "log-test-client",
      }),
      { statusCode: 401 },
    );
  } finally {
    for (const method of Object.keys(originals)) {
      console[method] = originals[method];
    }
  }

  assert.equal(JSON.stringify(captured).includes(submittedCode), false);
});

test("sixth failed attempt is rate limited", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      accessGateService.verifyAccessCode({
        code: `WRONG-${attempt}`,
        clientKey: "rate-limit-client",
      }),
      { statusCode: 401 },
    );
  }

  await assert.rejects(
    accessGateService.verifyAccessCode({
      code: SYNTHETIC_CODES.student,
      clientKey: "rate-limit-client",
    }),
    { statusCode: 429, code: "ACCESS_GATE_RATE_LIMITED" },
  );
});

test("student gate cannot enumerate staff or management accounts", async () => {
  const student = await verify("student");

  for (const role of ["teacher", "mentor", "management"]) {
    const { response } = await request(
      `/api/auth/demo-accounts?role=${role}`,
      { gateToken: student.json.gateToken },
    );
    assert.equal(response.status, 403);
  }
});

test("staff gate cannot enumerate student or management accounts", async () => {
  const staff = await verify("staff");

  for (const role of ["student", "management"]) {
    const { response } = await request(
      `/api/auth/demo-accounts?role=${role}`,
      { gateToken: staff.json.gateToken },
    );
    assert.equal(response.status, 403);
  }
});

test("management gate cannot enumerate student or staff accounts", async () => {
  const management = await verify("management");

  for (const role of ["student", "teacher", "mentor"]) {
    const { response } = await request(
      `/api/auth/demo-accounts?role=${role}`,
      { gateToken: management.json.gateToken },
    );
    assert.equal(response.status, 403);
  }
});

test("Quick Fill still returns an authorised group's account data", async () => {
  const originalListDemoAccounts = authService.listDemoAccounts;
  let capturedRequest;
  authService.listDemoAccounts = async (input) => {
    capturedRequest = input;
    return [
      {
        name: "Synthetic Learner",
        email: "learner@example.invalid",
        role: "student",
      },
    ];
  };

  try {
    const student = await verify("student");
    const { response, json } = await request(
      "/api/auth/demo-accounts?role=student",
      { gateToken: student.json.gateToken },
    );

    assert.equal(response.status, 200);
    assert.equal(json.accounts.length, 1);
    assert.deepEqual(capturedRequest, {
      role: "student",
      accessGroup: "student",
    });
  } finally {
    authService.listDemoAccounts = originalListDemoAccounts;
  }
});

test("each gate group permits exactly its legitimate Quick Fill roles", () => {
  assert.equal(
    accessGateService.assertRoleAllowed({
      accessGroup: "student",
      role: "student",
    }),
    "student",
  );
  assert.equal(
    accessGateService.assertRoleAllowed({
      accessGroup: "staff",
      role: "teacher",
    }),
    "teacher",
  );
  assert.equal(
    accessGateService.assertRoleAllowed({
      accessGroup: "staff",
      role: "mentor",
    }),
    "mentor",
  );
  assert.equal(
    accessGateService.assertRoleAllowed({
      accessGroup: "management",
      role: "management",
    }),
    "management",
  );
});

test("Quick Fill rejects a missing or invalid gate token", async () => {
  const missing = await request("/api/auth/demo-accounts?role=student");
  const invalid = await request("/api/auth/demo-accounts?role=student", {
    gateToken: "not-a-signed-token",
  });

  assert.equal(missing.response.status, 401);
  assert.equal(invalid.response.status, 401);
});

test("normal email and password login route remains available", async () => {
  const originalLogin = authService.login;
  let capturedCredentials;
  authService.login = async (credentials) => {
    capturedCredentials = credentials;
    return {
      token: "synthetic-user-token",
      user: { id: "user-1", role: "student" },
    };
  };

  try {
    const { response, json } = await request("/api/auth/login", {
      method: "POST",
      body: {
        email: "learner@example.invalid",
        password: "synthetic-password",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(json.token, "synthetic-user-token");
    assert.deepEqual(capturedCredentials, {
      email: "learner@example.invalid",
      password: "synthetic-password",
    });
  } finally {
    authService.login = originalLogin;
  }
});
