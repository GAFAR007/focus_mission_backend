# Pong Challenge

Pong is a teacher-controlled, game-only feature. It does not write learning XP,
certification, missions, submissions or result evidence. The existing authenticated
school context and `schoolScopedSchema` protect all three new collections.

## Ownership and persistence

- `PongProfile`: one profile per school/student, opaque public handle, staff access,
  saved progress, private presence timestamp and an active-match reservation.
- `PongChallenge`: explicit, 90-second invitation with a unique pending pair key.
- `PongMatch`: participants, authoritative simulation snapshot, outcome and lease.

Only an active assigned teacher or management account can change access. New
profiles start with Game Access off, Computer Mode on and Student Battles off.
Students cannot write their own permissions. Disabling access preserves progress
and terminates affected active games without awarding a winner.

`migrateProfiles()` runs after the existing school migration, initializes indexes
and adds missing student profiles with `$setOnInsert`. It is safe to repeat. It
does not reset existing access, progress or academic fields. New students receive
the same defaults lazily. Legacy school assignments remain the responsibility of
the existing guarded single-school migration; Pong adds no tenant fallback.

## Game rules

All levels use one ball, delayed/imperfect computer reactions and bounded paddle
movement. Completed levels can be replayed. A transaction saves each result once
and unlocks at most the next level. Solo misses are practice results with no
academic penalty. Classic PvP starts with equal paddles and neutral physics,
first to 7. Power Battle keeps the same match goal and adds mirrored temporary
boosts after both players explicitly choose and accept that ruleset.

| Level | Challenge | Returns |
| --- | --- | --- |
| 1 | Getting Started | 5 |
| 2 | A Little Faster | 8 |
| 3 | Picking Up Speed | 10 |
| 4 | Sharp Angles | 12 |
| 5 | Smaller Paddle | 12 |
| 6 | Centre Wall | 15 |
| 7 | Moving Wall | 15 |
| 8 | Speed Zones | 18 |
| 9 | Narrow Defence | 18 |
| 10 | Zigzag Arena | 20 |
| 11 | Fast Returns | 22 |
| 12 | Moving Barriers | 25 |
| 13 | Gravity Zone | 25 |
| 14 | Expert Arena | 30 |
| 15 | Final Challenge | 35 |

## Realtime and consent

The existing HTTP package receives authenticated server-sent events; HTTP commands
carry only paddle direction/target and a monotonically increasing sequence. Each
stream issues a fresh controller token so stale tabs cannot steer a paddle. Bearer
tokens never appear in URLs. A new dependency or separate realtime platform is not
required. The server advances physics in small substeps and broadcasts at 20 Hz.

Acceptance rechecks both accounts, school, permissions, availability and expiry
inside a transaction. Reserving both profiles prevents duplicate live matches.
Conflicting invitations are cancelled. Rematches are new invitations requiring
acceptance. A short cooldown limits invitation spam. There is no chat.

The lobby returns shortened names, random game handles, level, wins and coarse
availability. It never returns database IDs, email addresses, academic data or
precise presence timestamps. Search is applied only to the scoped private names.

Connections pause when a player disconnects or stops sending input. A 20-second
grace period allows reconnection; expiry cancels without a winner. Solo pause,
restart and exit also preserve earlier progress. Access/account status is checked
throughout play and again inside the result transaction.

## Hosting and recovery

The current deployment uses a single Node process. A Mongo lease fences each
authoritative room; snapshots are saved every second and final results immediately.
A new process may recover only after the old lease expires. Persistence errors
stop the room rather than simulating unsaved outcomes. Stale reservations expire
without a winner when the student reconnects after the recovery window.

If hosting is scaled to multiple concurrent processes, configure session affinity
for a game's stream and input requests before enabling that topology. Requests
routed to a non-owning process fail closed; they never start a competing engine.
No cross-process forwarding system is introduced for today's single-process host.

## Verification and release

`test/pongPhysics.test.js` simulates legal controls through all 15 levels and checks
one-ball invariants, collision bounds, computer reaction limits and fair PvP.
`test/pongIsolation.test.js` uses a real disposable Mongo replica set for migration,
permission denial, privacy, sequential unlocks, idempotent results, invitation
races, rematches, authenticated streams, synchronized scores, lease fencing,
disconnect expiry and unchanged academic XP. The full backend suite has 192
passing tests with no skips at the pre-release checkpoint.

Flutter tests cover narrow layouts, disabled access, staff permission payloads,
keyboard release, server-owned result rendering and guarded arena navigation.
Local browser acceptance uses synthetic teacher/PongA/PongB accounts on an isolated
database. Production smoke accounts are separately authorized and must be archived
after verification. No real learner's game record is used for smoke testing.

The local browser checkpoint verified teacher enable/disable, the disabled student
message, Level 1 completion (five returns, longest rally ten), saved Level 2 unlock
and replay, privacy-safe lobby names, invitation/acceptance, a complete 7-6 battle
shown by both clients, saved stats after refresh, a new accepted rematch, and a
teacher stop during that rematch with no winner. Solo pause/resume and returning
from the arena were exercised. The browser check caught and fixed guarded-route
navigation and result-screen reconnect feedback before release.

Use the frontend repository's `RELEASE.md` and `tool/release.mjs` for the paired
minor release. Local tests are not deployment evidence. The command builds clean
committed archives and verifies exact Render revision and Netlify artifact bytes.

## Vertical gameplay upgrade

The server retains its canonical 1000-by-560 coordinate system so persisted
matches and the existing control API remain compatible. Each client projects
that world into a 560-by-1000 vertical court. Player zero uses `(y, 1000-x)`;
player one uses `(560-y, x)`. The inverse input mapping makes A/D, left/right
arrows and horizontal touch motion natural for both students. Forward is a
bounded distance toward the centre, independent of which baseline they defend.

Moving strikes combine impact offset, actual paddle velocity, modest rally
escalation and a capped power modifier. Spin decays and cannot reverse the
forward direction. The engine applies each level's speed limits and an absolute
680-unit safety ceiling after every physics modifier, including speed zones.
Focus changes server-owned ball displacement in the receiving half for both
clients; it never slows a client's independent simulation.

`pongPowerUps.js` owns seven effects: Speed (30%, 5s), Wide Paddle (35%, 6s),
Power Shot (next hit, 8s expiry), Shield (one save, 10s expiry), Forward Rush
(4s, maximum 110 units into the player's half), Curve (next hit, 8s expiry), and
Focus (3s). Shot/curve/shield share one temporary slot; collecting another stored
boost cannot replace or stack it. Width and forward depth return smoothly.
Simulation time pauses all timers when the authoritative game is paused.

Level 1 has no drops; levels 2-8 introduce Speed, Wide, Power, Shield, Rush,
Curve and Focus in that order. Drops arrive every 10-18 simulation seconds
(10-14 at level 10+). At most two exist: identical mirrored opportunities with
equal travel times. They must touch the intended paddle and expire if missed.
The AI may chase a drop only by moving its own bounded paddle. Its reaction,
error, movement and risk appetite remain capped by the current level. Match-only
hit and collection aggregates inform small adjustments; they contain no learner
identity, academic results, SEN data or notes. No Ollama call, training or external
strategy dependency is introduced; disconnected/offline model services cannot
interrupt the deterministic opponent.

Classic remains the default PvP ruleset. Power Battle is an explicit invitation
choice, independently permitted for both students. Acceptance must echo `power`,
so an old client that cannot display those rules cannot accidentally accept them.
Rematches keep their previous rules. Turning Power Battle off cancels only power
invitations/games, leaving permitted Classic play and all historical stats intact.
The additive migration sets the new permission to false only where missing.

The HUD names the opponent above and the local student below. Boosts show symbols,
labels, expiry and READY state. Speed controls trail length, particles and hit
feedback; reduced motion suppresses trails, flashes, sparks and court pulses.
Optional sound starts muted and uses the existing audio package with six short,
original generated tones stored in the frontend's `assets/sounds/pong/` folder.
