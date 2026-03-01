# Focus Mission - Backend Agent Rules

This backend powers qualification progression.

Domain direction:
- Subject -> Unit -> Criterion -> Block
- StudentProgress records completion state against criteria

Precision matters. This logic determines what a learner sees next.

If a change risks progression safety, STOP and ASK.

---

## 0) Goal

Build a stable, documented, progression-safe API that:

- Correctly resolves daily missions
- Tracks unit and criterion completion
- Protects role boundaries
- Produces predictable responses
- Remains testable and debuggable
- Stays simple enough to maintain

---

## 1) Architecture (Clean Architecture-ish)

Required flow:

Routes -> Controllers -> Services -> Models

Never mix logic layers.

Routes:
- Define endpoint paths
- Attach middleware
- Delegate immediately

Controllers:
- Validate request shape
- Extract trusted input
- Call services
- Shape HTTP response

Services:
- Own ALL business logic
- Resolve missions
- Calculate progression
- Decide completion
- Build structured payloads

Models:
- Define schema and indexes
- Define refs and enums
- Do not contain feature logic

If logic starts being reused or grows beyond trivial formatting, it belongs in a service.

---

## 2) Core Hierarchy (DO NOT ALTER CASUALLY)

Canonical hierarchy:

Subject
-> Unit
-> Criterion
-> Block

StudentProgress tracks:

- studentId
- criterionId
- generatedEssay
- wordCount
- progressPercent
- completed

Do NOT flatten this hierarchy.
Do NOT skip levels for convenience.
Do NOT embed progression decisions in controllers or routes.

---

## 3) Mission Resolution Logic (CRITICAL)

When `Start Mission` is called, the service layer must:

1. Determine today's subject from timetable
2. Get the active unit for that subject
3. Find the first incomplete criterion in the correct order
4. Fetch the next five incomplete blocks
5. Return a structured mission payload

Rules:
- Ordering must be explicit
- Completion checks must be explicit
- Fallback behavior must be documented
- Response shape must stay predictable

This logic MUST live in the service layer.

---

## 4) Progression Safety Rules

Any code that changes:

- Completion thresholds
- Unit unlocking
- Criterion ordering
- Block selection order
- Progress percentage calculation
- Mission payload structure

is high-risk.

STOP and ASK before changing behavior in those areas unless the task explicitly requires it.

---

## 5) Documentation Rules (MANDATORY)

Every new or substantially modified source file must begin with:

```text
/**
 * WHAT:
 * WHY:
 * HOW:
 */
```

Add WHY comments at important boundaries:

- Why validation exists
- Why a query is shaped a certain way
- Why sort order matters
- Why a completion threshold exists
- Why a fallback branch is safe

No silent logic blocks.

If behavior is easy to misunderstand later, document it now.

---

## 6) Logging Rule

Service-level logic must log enough to debug progression issues.

Each meaningful service flow should log:

- Entry
- Key decisions
- Result summary
- Exit state

Logging must be useful, not noisy.
Never log secrets, tokens, or sensitive personal data.

---

## 7) Validation and Error Shape

Validate request payloads before business logic runs.

All errors must return:

```json
{
  "success": false,
  "message": "...",
  "code": "ERROR_CODE"
}
```

Rules:
- Never leak stack traces to clients
- Never return ad hoc error shapes
- Prefer specific error codes over generic failures

Successful responses should also stay consistent across endpoints.

---

## 8) Mongoose Rules

Use Mongoose for schema definition only.

Schema expectations:

- Core records should use timestamps
- Enums should be explicit
- References should be normalized
- Frequently queried fields should gain indexes once usage is clear

Keep schema files inside `src/models`.
Do not scatter model definitions across the repo.

---

## 9) Role and Security Rules

Protect role-specific routes with middleware.

Do not trust:

- Client-supplied role values
- Client-supplied progression state
- Client-side completion calculations

Authorization and progression truth must live on the backend.

---

## 10) Prevent Overengineering

Avoid:

- Repository layers with no real need
- Event systems before one exists in product scope
- Generic rule engines too early
- Deep abstraction over straightforward Mongoose queries

Prefer a direct, well-documented service over a clever but opaque architecture.

---

## 11) Prevent Chaotic Refactors

Do not:

- Rename the domain hierarchy casually
- Rework controllers and services in the same sweep without reason
- Move files across layers just to satisfy aesthetics
- Mix cleanup refactors into progression-critical tickets

Refactors must be:

- Scoped
- Behavior-preserving unless explicitly requested
- Documented

---

## 12) Backend File Placement

Backend source of truth:

```text
focus_mission_backend/
├── AGENTS.md
├── server.js
└── src/
    ├── config/
    ├── controllers/
    ├── middleware/
    ├── models/
    ├── routes/
    └── services/
```

Respect that structure.

---

## 13) STOP Conditions

STOP and ASK before changing:

- Progress logic
- Completion thresholds
- Unit unlocking behavior
- Criterion ordering rules
- Mission resolution behavior
- Stored response contracts consumed by the app
