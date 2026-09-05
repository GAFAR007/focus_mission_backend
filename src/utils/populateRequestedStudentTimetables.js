/**
 * WHAT:
 * populateRequestedStudentTimetables safely installs the requested Group 1 and
 * Group 3 weekly timetables and verifies protected Jace and Sudais schedules.
 * WHY:
 * Live student timetable data must match the agreed weekly teaching plan while
 * every named Business slot remains owned by Gafar Temitayo Razak.
 * HOW:
 * Resolve existing users and canonical subjects by normalized names, create the
 * exact Art (Music) subject once, upsert one weekday record per requested group
 * student, and only repair Business teacher refs on protected timetables.
 */
require("dotenv").config();

const mongoose = require("mongoose");

const connectDB = require("../config/db");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const User = require("../models/User");

const APPLY_FLAG = "--apply";
const BUSINESS_TEACHER_NAME = "Gafar Temitayo Razak";
const ART_MUSIC_SUBJECT_NAME = "Art (Music)";
const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];

const GROUP_1_STUDENTS = [
  "Tamanna Iqbal",
  "Luqman Tariq",
  "Grace Wesson",
];
const GROUP_3_STUDENTS = [
  "Ahmed Stockwin",
  "Asia-Lei Waller",
  "Kerine Ryan",
];
const JACE_NAME = "Jace Mckenzie";
const SUDAIS_NAME = "Sudais Dahir";

const GROUP_1_TIMETABLE = [
  ["Monday", "Business", "Life Skill"],
  ["Tuesday", ART_MUSIC_SUBJECT_NAME, "Sport"],
  ["Wednesday", "ICT", "Art"],
  ["Thursday", "Mathematics", "Science"],
  ["Friday", "GCSE Citizenship", "English"],
];

const GROUP_3_TIMETABLE = [
  ["Monday", "Science", "Business"],
  ["Tuesday", "Life Skill", ART_MUSIC_SUBJECT_NAME],
  ["Wednesday", "English", "ICT"],
  ["Thursday", "Art", "Mathematics"],
  ["Friday", "Sport", "GCSE Citizenship"],
];

const JACE_EXPECTED_TIMETABLE = [
  ["Monday", "Life Skill", "Art"],
  ["Tuesday", "Sport", "GCSE Citizenship"],
  ["Wednesday", "Art", "Mathematics"],
  ["Thursday", "Science", "Business"],
  ["Friday", "English", "ICT"],
];

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegularExpression(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function idsMatch(left, right) {
  return String(left || "") === String(right || "");
}

function timetableSpecToObjects(spec) {
  return spec.map(([day, morningSubject, afternoonSubject]) => ({
    day,
    morningSubject,
    afternoonSubject,
  }));
}

async function resolveUniqueUserByName({ name, role, session }) {
  const users = await User.find({ role })
    .select("_id name role assignedStudents")
    .session(session || null)
    .lean();
  const normalizedTarget = normalizeName(name);
  const matches = users.filter(
    (user) => normalizeName(user.name) === normalizedTarget,
  );

  // WHY: Timetable population must never guess between similar accounts or
  // create duplicate users when capitalization differs in the live record.
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${role} named ${name}; found ${matches.length}.`,
    );
  }

  return matches[0];
}

async function resolveUniqueSubjectByName({ name, session }) {
  const matches = await Subject.find({
    name: new RegExp(`^${escapeRegularExpression(name)}$`, "i"),
  })
    .select("_id name icon color difficultyDefaults")
    .session(session || null)
    .lean();

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one subject named ${name}; found ${matches.length}.`,
    );
  }

  return matches[0];
}

async function resolveSubjects({ createArtMusic, session }) {
  const requestedNames = new Set(
    [...GROUP_1_TIMETABLE, ...GROUP_3_TIMETABLE]
      .flatMap((entry) => entry.slice(1))
      .filter((name) => name !== ART_MUSIC_SUBJECT_NAME),
  );
  const subjects = new Map();

  for (const name of requestedNames) {
    subjects.set(
      name,
      await resolveUniqueSubjectByName({ name, session }),
    );
  }

  const artMusicMatches = await Subject.find({
    name: new RegExp(
      `^${escapeRegularExpression(ART_MUSIC_SUBJECT_NAME)}$`,
      "i",
    ),
  })
    .select("_id name icon color difficultyDefaults")
    .session(session || null)
    .lean();

  if (artMusicMatches.length > 1) {
    throw new Error(
      `Expected at most one ${ART_MUSIC_SUBJECT_NAME} subject; found ${artMusicMatches.length}.`,
    );
  }

  if (artMusicMatches.length === 1) {
    subjects.set(ART_MUSIC_SUBJECT_NAME, artMusicMatches[0]);
    return { subjects, artMusicCreated: false };
  }

  if (!createArtMusic) {
    return { subjects, artMusicCreated: true };
  }

  const baseArt = subjects.get("Art");
  const [artMusic] = await Subject.create(
    [
      {
        name: ART_MUSIC_SUBJECT_NAME,
        icon: baseArt.icon,
        color: baseArt.color,
        difficultyDefaults: baseArt.difficultyDefaults,
      },
    ],
    { session },
  );
  subjects.set(ART_MUSIC_SUBJECT_NAME, artMusic.toObject());

  return { subjects, artMusicCreated: true };
}

async function loadStudentTimetable({ studentId, session }) {
  return Timetable.find({ studentId })
    .populate("morningSubject", "name")
    .populate("afternoonSubject", "name")
    .session(session || null)
    .lean();
}

function assertOneEntryPerWeekday(studentName, entries) {
  for (const day of WEEKDAYS) {
    const matchingEntries = entries.filter(
      (entry) => normalizeName(entry.day) === normalizeName(day),
    );

    // WHY: Silently choosing one duplicate could hide conflicting live lesson
    // ownership, so ambiguous student/day data must stop before any mutation.
    if (matchingEntries.length > 1) {
      throw new Error(
        `${studentName} has ${matchingEntries.length} timetable entries for ${day}.`,
      );
    }
  }
}

function assertExpectedSchedule({ studentName, entries, expectedSpec }) {
  assertOneEntryPerWeekday(studentName, entries);

  for (const expected of timetableSpecToObjects(expectedSpec)) {
    const entry = entries.find(
      (candidate) => normalizeName(candidate.day) === normalizeName(expected.day),
    );
    const morningName = String(entry?.morningSubject?.name || "");
    const afternoonName = String(entry?.afternoonSubject?.name || "");

    // WHY: Post-write validation and Jace's protected schedule both require an
    // exact subject/day match rather than accepting a partially populated week.
    if (
      !entry ||
      normalizeName(morningName) !== normalizeName(expected.morningSubject) ||
      normalizeName(afternoonName) !== normalizeName(expected.afternoonSubject)
    ) {
      throw new Error(
        `${studentName}'s protected ${expected.day} timetable does not match the expected schedule.`,
      );
    }
  }
}

function buildProtectedSnapshot(entries, businessSubjectId) {
  return entries
    .map((entry) => ({
      id: String(entry._id || ""),
      day: String(entry.day || ""),
      room: String(entry.room || ""),
      mentorId: String(entry.mentorId || ""),
      morningSubjectId: String(entry.morningSubject?._id || ""),
      afternoonSubjectId: String(entry.afternoonSubject?._id || ""),
      morningTeacherId: idsMatch(entry.morningSubject?._id, businessSubjectId)
        ? "BUSINESS_TEACHER_CAN_CHANGE"
        : String(entry.morningTeacherId || ""),
      afternoonTeacherId: idsMatch(entry.afternoonSubject?._id, businessSubjectId)
        ? "BUSINESS_TEACHER_CAN_CHANGE"
        : String(entry.afternoonTeacherId || ""),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function planGroupStudent({
  student,
  timetableSpec,
  subjects,
  businessTeacher,
  session,
}) {
  const entries = await loadStudentTimetable({
    studentId: student._id,
    session,
  });
  assertOneEntryPerWeekday(student.name, entries);

  return timetableSpecToObjects(timetableSpec).map((expected) => {
    const existing = entries.find(
      (entry) => normalizeName(entry.day) === normalizeName(expected.day),
    );
    const morningSubject = subjects.get(expected.morningSubject);
    const afternoonSubject = subjects.get(expected.afternoonSubject);

    if (!morningSubject || !afternoonSubject) {
      return {
        student,
        expected,
        existing,
        changes: [
          existing
            ? `subject naming -> ${ART_MUSIC_SUBJECT_NAME}`
            : "create weekday entry",
        ],
        unresolvedArtMusic: true,
      };
    }

    const update = {
      studentId: student._id,
      day: expected.day,
      morningSubject: morningSubject._id,
      afternoonSubject: afternoonSubject._id,
    };

    if (expected.morningSubject === "Business") {
      update.morningTeacherId = businessTeacher._id;
    } else if (
      existing?.morningTeacherId &&
      !idsMatch(existing.morningSubject?._id, morningSubject._id)
    ) {
      // WHY: A teacher from a replaced subject must not retain ownership of an
      // unrelated lesson. New non-Business ownership remains unassigned until
      // management supplies it, because this task authorizes only Gafar's role.
      update.morningTeacherId = null;
    }

    if (expected.afternoonSubject === "Business") {
      update.afternoonTeacherId = businessTeacher._id;
    } else if (
      existing?.afternoonTeacherId &&
      !idsMatch(existing.afternoonSubject?._id, afternoonSubject._id)
    ) {
      update.afternoonTeacherId = null;
    }

    const changes = [];
    if (!existing) {
      changes.push("create weekday entry");
    } else {
      if (!idsMatch(existing.morningSubject?._id, morningSubject._id)) {
        changes.push(`morning subject -> ${expected.morningSubject}`);
      }
      if (!idsMatch(existing.afternoonSubject?._id, afternoonSubject._id)) {
        changes.push(`afternoon subject -> ${expected.afternoonSubject}`);
      }
      if (
        expected.morningSubject === "Business" &&
        !idsMatch(existing.morningTeacherId, businessTeacher._id)
      ) {
        changes.push(`morning teacher -> ${BUSINESS_TEACHER_NAME}`);
      }
      if (
        expected.afternoonSubject === "Business" &&
        !idsMatch(existing.afternoonTeacherId, businessTeacher._id)
      ) {
        changes.push(`afternoon teacher -> ${BUSINESS_TEACHER_NAME}`);
      }
    }

    return {
      student,
      expected,
      existing,
      update,
      changes,
      unresolvedArtMusic: false,
    };
  });
}

async function applyGroupPlans({ plans, session }) {
  for (const plan of plans) {
    if (plan.unresolvedArtMusic) {
      throw new Error(
        `${ART_MUSIC_SUBJECT_NAME} must be resolved before timetable writes.`,
      );
    }

    if (plan.changes.length === 0) {
      continue;
    }

    await Timetable.findOneAndUpdate(
      {
        studentId: plan.student._id,
        day: plan.expected.day,
      },
      {
        $set: plan.update,
        $setOnInsert: {
          room: "",
          mentorId: null,
        },
      },
      {
        returnDocument: "after",
        upsert: true,
        setDefaultsOnInsert: true,
        session,
      },
    );
  }
}

async function repairProtectedBusinessTeachers({
  protectedStudents,
  businessSubject,
  businessTeacher,
  session,
}) {
  const studentIds = protectedStudents.map((student) => student._id);

  // WHY: Jace and Sudais permit only Business-teacher correction. Separate
  // subject-qualified updates make that boundary explicit and auditable.
  const morningResult = await Timetable.updateMany(
    {
      studentId: { $in: studentIds },
      morningSubject: businessSubject._id,
      morningTeacherId: { $ne: businessTeacher._id },
    },
    { $set: { morningTeacherId: businessTeacher._id } },
    { session },
  );
  const afternoonResult = await Timetable.updateMany(
    {
      studentId: { $in: studentIds },
      afternoonSubject: businessSubject._id,
      afternoonTeacherId: { $ne: businessTeacher._id },
    },
    { $set: { afternoonTeacherId: businessTeacher._id } },
    { session },
  );

  return {
    protectedMorningBusinessTeachersRepaired: morningResult.modifiedCount,
    protectedAfternoonBusinessTeachersRepaired: afternoonResult.modifiedCount,
  };
}

async function assertBusinessTeacherAssignments({
  students,
  businessSubject,
  businessTeacher,
  session,
}) {
  const entries = await Timetable.find({
    studentId: { $in: students.map((student) => student._id) },
    $or: [
      { morningSubject: businessSubject._id },
      { afternoonSubject: businessSubject._id },
    ],
  })
    .session(session || null)
    .lean();

  for (const entry of entries) {
    if (
      idsMatch(entry.morningSubject, businessSubject._id) &&
      !idsMatch(entry.morningTeacherId, businessTeacher._id)
    ) {
      throw new Error("A requested morning Business slot has the wrong teacher.");
    }
    if (
      idsMatch(entry.afternoonSubject, businessSubject._id) &&
      !idsMatch(entry.afternoonTeacherId, businessTeacher._id)
    ) {
      throw new Error("A requested afternoon Business slot has the wrong teacher.");
    }
  }

  return entries.length;
}

async function assertGroupSchedules({ groupPlans, session }) {
  for (const groupPlan of groupPlans) {
    const entries = await loadStudentTimetable({
      studentId: groupPlan.student._id,
      session,
    });
    assertExpectedSchedule({
      studentName: groupPlan.student.name,
      entries,
      expectedSpec: groupPlan.timetableSpec,
    });
  }
}

async function resolveContext({ createArtMusic, session }) {
  const studentSpecs = [
    ...GROUP_1_STUDENTS.map((name) => ({
      name,
      timetableSpec: GROUP_1_TIMETABLE,
    })),
    ...GROUP_3_STUDENTS.map((name) => ({
      name,
      timetableSpec: GROUP_3_TIMETABLE,
    })),
  ];
  const groupPlans = [];

  for (const studentSpec of studentSpecs) {
    groupPlans.push({
      ...studentSpec,
      student: await resolveUniqueUserByName({
        name: studentSpec.name,
        role: "student",
        session,
      }),
    });
  }

  const jace = await resolveUniqueUserByName({
    name: JACE_NAME,
    role: "student",
    session,
  });
  const sudais = await resolveUniqueUserByName({
    name: SUDAIS_NAME,
    role: "student",
    session,
  });
  const businessTeacher = await resolveUniqueUserByName({
    name: BUSINESS_TEACHER_NAME,
    role: "teacher",
    session,
  });
  const subjectResult = await resolveSubjects({ createArtMusic, session });

  return {
    groupPlans,
    jace,
    sudais,
    businessTeacher,
    ...subjectResult,
  };
}

async function buildPlans({ context, session }) {
  const plans = [];
  for (const groupPlan of context.groupPlans) {
    plans.push(
      ...(await planGroupStudent({
        student: groupPlan.student,
        timetableSpec: groupPlan.timetableSpec,
        subjects: context.subjects,
        businessTeacher: context.businessTeacher,
        session,
      })),
    );
  }
  return plans;
}

async function auditProtectedStudents({ context, session }) {
  const businessSubject = context.subjects.get("Business");
  const jaceEntries = await loadStudentTimetable({
    studentId: context.jace._id,
    session,
  });
  const sudaisEntries = await loadStudentTimetable({
    studentId: context.sudais._id,
    session,
  });

  assertExpectedSchedule({
    studentName: context.jace.name,
    entries: jaceEntries,
    expectedSpec: JACE_EXPECTED_TIMETABLE,
  });
  assertOneEntryPerWeekday(context.sudais.name, sudaisEntries);

  return {
    jaceSnapshot: buildProtectedSnapshot(jaceEntries, businessSubject._id),
    sudaisSnapshot: buildProtectedSnapshot(sudaisEntries, businessSubject._id),
  };
}

async function verifyProtectedSnapshots({ context, snapshots, session }) {
  const businessSubject = context.subjects.get("Business");
  const jaceEntries = await loadStudentTimetable({
    studentId: context.jace._id,
    session,
  });
  const sudaisEntries = await loadStudentTimetable({
    studentId: context.sudais._id,
    session,
  });
  const currentJaceSnapshot = buildProtectedSnapshot(
    jaceEntries,
    businessSubject._id,
  );
  const currentSudaisSnapshot = buildProtectedSnapshot(
    sudaisEntries,
    businessSubject._id,
  );

  if (JSON.stringify(currentJaceSnapshot) !== JSON.stringify(snapshots.jaceSnapshot)) {
    throw new Error("Jace's protected timetable changed outside Business teacher ownership.");
  }
  if (
    JSON.stringify(currentSudaisSnapshot) !==
    JSON.stringify(snapshots.sudaisSnapshot)
  ) {
    throw new Error("Sudais' protected timetable changed outside Business teacher ownership.");
  }
}

async function populateRequestedStudentTimetables({ apply }) {
  await connectDB();
  if (!process.env.MONGODB_URI) {
    throw new Error("Set MONGODB_URI before running this timetable operation.");
  }

  if (!apply) {
    const context = await resolveContext({ createArtMusic: false });
    const snapshots = await auditProtectedStudents({ context });
    const plans = await buildPlans({ context });

    return {
      mode: "dry-run",
      artMusicSubjectWillBeCreated: context.artMusicCreated,
      timetableEntriesToChange: plans.filter((plan) => plan.changes.length > 0)
        .length,
      plannedChanges: plans
        .filter((plan) => plan.changes.length > 0)
        .map((plan) => ({
          student: plan.student.name,
          day: plan.expected.day,
          changes: plan.changes,
        })),
      protectedTimetableRecordsChecked:
        snapshots.jaceSnapshot.length + snapshots.sudaisSnapshot.length,
    };
  }

  let result;
  await mongoose.connection.transaction(async (session) => {
    const context = await resolveContext({ createArtMusic: true, session });
    const snapshots = await auditProtectedStudents({ context, session });
    const plans = await buildPlans({ context, session });
    const protectedRepair = await repairProtectedBusinessTeachers({
      protectedStudents: [context.jace, context.sudais],
      businessSubject: context.subjects.get("Business"),
      businessTeacher: context.businessTeacher,
      session,
    });

    await applyGroupPlans({ plans, session });

    const requestedStudents = [
      ...context.groupPlans.map((item) => item.student),
      context.jace,
      context.sudais,
    ];

    // WHY: Teacher workspace access is driven by assignedStudents as well as
    // timetable refs, so Gafar must gain each requested Business learner once.
    const assignedStudentIds = new Set(
      (context.businessTeacher.assignedStudents || []).map((value) =>
        String(value || ""),
      ),
    );
    const missingBusinessStudents = requestedStudents.filter(
      (student) => !assignedStudentIds.has(String(student._id)),
    );
    if (missingBusinessStudents.length > 0) {
      await User.updateOne(
        { _id: context.businessTeacher._id, role: "teacher" },
        {
          $addToSet: {
            assignedStudents: {
              $each: missingBusinessStudents.map((student) => student._id),
            },
          },
        },
        { session },
      );
    }

    await assertGroupSchedules({ groupPlans: context.groupPlans, session });
    await verifyProtectedSnapshots({ context, snapshots, session });
    const businessTimetableRecordsChecked =
      await assertBusinessTeacherAssignments({
        students: requestedStudents,
        businessSubject: context.subjects.get("Business"),
        businessTeacher: context.businessTeacher,
        session,
      });

    result = {
      mode: "apply",
      artMusicSubjectCreated: context.artMusicCreated,
      timetableEntriesChanged: plans.filter((plan) => plan.changes.length > 0)
        .length,
      groupStudentsVerified: context.groupPlans.map((item) => item.student.name),
      protectedStudentsVerified: [context.jace.name, context.sudais.name],
      businessTeacher: context.businessTeacher.name,
      businessTimetableRecordsChecked,
      ...protectedRepair,
    };
  });

  return result;
}

if (require.main === module) {
  const apply = process.argv.slice(2).includes(APPLY_FLAG);
  populateRequestedStudentTimetables({ apply })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!apply) {
        console.log(
          `Dry run only. Re-run with ${APPLY_FLAG} to write the verified changes.`,
        );
      }
    })
    .catch((error) => {
      console.error(
        `Requested timetable population failed: ${error.message}`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.connection.close();
    });
}

module.exports = {
  populateRequestedStudentTimetables,
};
