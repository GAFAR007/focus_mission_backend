# 6K Journey, school boundaries and XP history

Implemented locally. Not committed, pushed, deployed or migrated in production.

## Confirmed decisions

All existing accounts belong to one school. Create `Current School` once and
backfill existing records without changing their IDs, balances, credentials,
assignments or evidence. Future schools have separate records and accounts.
Accurate weekly tracking starts at rollout; do not reconstruct missing history.

## School boundary

`School` stores name, active status, timestamps and the XP tracking start date.
Every tenant-owned schema has required, immutable `schoolId`. Authentication
resolves it from the persisted account, not a token role or a client school ID.
The persistence boundary scopes reads, populations, counts, aggregates, writes,
bulk operations and reference validation. Missing context fails closed. School
admins retain their normal role permissions only within their own school.

The existing school-access codes/Quick Fill directory remain bound to Current
School. Future-school accounts can use their normal email/password login. A
future school-specific Quick Fill provisioning flow is not part of this change.

Raw collection access is restricted to the migration, credential-to-school
lookup and scoped reference validation. Maintenance scripts must explicitly
enter `runInSchool(schoolId, async () => { ... })`. Background email retries
iterate active schools in separate contexts. Aggregations involving joins or
write stages are rejected until a service supplies a reviewed school-safe path.
No platform-wide admin role was introduced.

## Automatic migration

Startup creates indexes and runs `migrateCurrentSchool()` before accepting HTTP
traffic. The default school has a unique migration key. A transaction backfills
school references, snapshots `User.xp` into `xpOpeningBalance`, records existing
milestones as legacy observations, and marks the migration complete. Restarting
preserves that marker and does not reset or replay balances.

Existing milestone crossing dates are unknown: `achievedAt` is null,
`recordedAt` is the rollout observation time, and the UI says "Achieved before
tracking began". New crossings have actual achievement timestamps.

## XP accounting

`User.xp` remains the authoritative current total. It is never capped at 6K or
rebuilt by summing old results. Reconciliation is the recorded opening balance
plus post-launch `XpTransaction.amount` deltas. The 200 daily target and existing
reward formulas/caps, qualification rules, streaks and redo semantics remain.

`XpSource` gives each student/source a cumulative applied total and revision.
`XpTransaction` records source type/ID, revision, school, student, amount and
actual processing/earned time. Review corrections are signed deltas, bounded so
balances do not go below zero. Pre-launch sources use their existing awarded
amount as a baseline; they do not become fabricated new weekly earnings.
Source state, result/target changes, balance, transaction and milestone records
commit or roll back together. Milestones never award extra XP.

| Award path | Identity and atomicity |
| --- | --- |
| Daily login | Student + date key; successful login/bonus is transactional. Failed-password tracking remains outside the success transaction. |
| Mission / redo | Result ID within the existing mission completion transaction; completed missions remain locked and redos retain separate IDs. |
| Teacher lesson log | Session-log ID, transactional; optional Idempotency-Key recovers the original create. |
| Mentor cover log | Cover assignment ID; repeated edits apply only the change. |
| Target create / edit | Target ID; caps, source, balance and target save share one transaction. Optional Idempotency-Key deduplicates creation. |
| Criterion submission | Student progress ID; first submission, notification, audit and reward commit together. |
| Theory / manual review | Result ID shared with original completion; rescores apply only the difference. |
| Standalone paper submission | Existing zero-XP behavior preserved. No new automatic reward. |

The Flutter API attaches an opaque key to each POST. A transport/API retry must
reuse that same Idempotency-Key; a newly initiated create request has a new key.
Legacy clients without a key still work; their create operations cannot be
identified as retries. Updates/reviews are protected by their existing record
source identity regardless of request keys.

## Rankings and presentation

Overall ranks current total XP; This week sums dated ledger deltas, including
score corrections, using the existing backend calendar-week policy. The first
week is labelled partial. Ties use stable student IDs; no rank is stored and no
historical achievement timestamps are invented for tie-breaking.

Only active, non-placeholder students in the authenticated school appear.
Student responses contain first name + surname initial and no peer IDs/emails.
Management sees full names within its school; teachers/mentors see full names
only for assigned students. Other permitted leaderboard identities stay abbreviated.

The student hero/profile use 6K progress, persisted milestone badges and a 10K
stretch goal. A compact button opens Overall/This week. Staff can open the same
leaderboard through their profile. Profile achievements show dates, and badges
remain after later score corrections. Existing compact mission and subject UI
is preserved. The unrelated mentor-screen working-tree edit was not modified
or included in the clean web artifact.

## Validation

- `node /tmp/focus-assignment-validation/run.cjs`: 142 passed, zero skipped.
  This starts a disposable local MongoDB replica set and runs `node --test
  test/*.test.js` with `FOCUS_TEST_MONGO_URI`; tests reject non-loopback URIs.
- Coverage includes automatic migration/restart, preservation of 554 XP,
  every milestone boundary, uncapped XP, duplicate/concurrent awards, rollback,
  target caps/edits, teacher and cover logs, criterion submission, both review
  paths, login failures, weekly filtering, privacy, cross-school reads/writes,
  population/bulk isolation, spoofed JWT/query school values, normal admin
  roster/archive boundaries and new-account school assignment.
- Flutter: 158 tests passed; `flutter analyze` found no issues.
- Clean allowlisted web artifact: `flutter build web --release` passed in
  `/tmp/focus-xp-web-pka5pnt1`, excluding the unrelated mentor edit.
- `git diff --check` passed in both repositories.
- Production migration and authenticated browser acceptance have not run.

See [XP_JOURNEY_RELEASE.md](XP_JOURNEY_RELEASE.md) for scoped release commands.
