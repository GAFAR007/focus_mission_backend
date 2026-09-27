# XP Journey release commands

Prepared but not executed. Review the staged diff before committing. The backend
must become live and complete its automatic migration before publishing the UI.
These explicit allowlists exclude unrelated archives, utility scripts and the
mentor-screen worktree edit. No new packages or manual student resets are needed.

## Backend

```sh
cd '/Users/gafar/Documents/Documents/myPlayGround/App/focus_mission_backend'
git add -- \
  server.js \
  src/app.js \
  src/controllers/mentor.controller.js \
  src/controllers/teacher.controller.js \
  src/middleware/auth.middleware.js \
  src/models/AuditLog.js \
  src/models/Block.js \
  src/models/Criterion.js \
  src/models/CriterionReportDraft.js \
  src/models/EvidenceReclassification.js \
  src/models/LearningContent.js \
  src/models/Mission.js \
  src/models/MissionWorkDraft.js \
  src/models/Notification.js \
  src/models/Question.js \
  src/models/QuestionEvidenceFile.js \
  src/models/ResultPackage.js \
  src/models/ResultScreenshot.js \
  src/models/SendLog.js \
  src/models/SessionCoverAssignment.js \
  src/models/SessionLog.js \
  src/models/StandalonePaper.js \
  src/models/StandalonePaperSession.js \
  src/models/StudentCertificationPlan.js \
  src/models/StudentProgress.js \
  src/models/Subject.js \
  src/models/Target.js \
  src/models/Timetable.js \
  src/models/Unit.js \
  src/models/User.js \
  src/routes/index.js \
  src/services/auth.service.js \
  src/services/criterionProgress.service.js \
  src/services/mentor.service.js \
  src/services/result.service.js \
  src/services/student.service.js \
  src/services/teacher.service.js \
  test/accessGate.test.js \
  test/assignedMissionLifecycle.test.js \
  XP_JOURNEY_AUDIT.md \
  XP_JOURNEY_RELEASE.md \
  src/controllers/xpJourney.controller.js \
  src/middleware/school.middleware.js \
  src/models/School.js \
  src/models/XpAchievement.js \
  src/models/XpSource.js \
  src/models/XpTransaction.js \
  src/routes/xpJourney.routes.js \
  src/services/school.service.js \
  src/services/xpJourney.service.js \
  src/utils/schoolScope.js \
  src/utils/xpRequestKey.js \
  test/xpJourneyIsolation.test.js
git diff --cached --stat
git diff --cached --check
git commit -m "Add school isolation and auditable XP journey"
git push origin main
git rev-parse HEAD
```

In Render, open **focus-mission-backend**. If automatic deployment has not
started, select **Manual Deploy → Deploy latest commit**. Wait for Live on the
exact revision printed above. Startup creates/backfills Current School before
opening the listener. Check the school migration completion log on first launch;
subsequent starts reuse the completed migration. Check:

```sh
curl --fail --silent --show-error https://focus-mission-backend.onrender.com/api/health
```

Verify existing login, dashboard XP and the new leaderboard using an authorised
account before publishing the frontend. The health response alone does not prove
migration data or UI acceptance. Take the normal database recovery snapshot
before the first rollout; this migration is additive and never resets balances.
Do not run a pre-ledger backend after new XP events without an explicit recovery
plan, because those writes would no longer be represented in weekly history.

## Frontend

```sh
cd '/Users/gafar/Documents/Documents/myPlayGround/App/focus_mission_app'
git add -- \
  lib/core/utils/focus_mission_api.dart \
  lib/features/student/presentation/student_dashboard_screen.dart \
  lib/shared/models/focus_mission_models.dart \
  lib/shared/models/xp_journey.dart \
  lib/shared/widgets/profile_sheet.dart \
  lib/shared/widgets/progress_hero_card.dart \
  lib/shared/widgets/xp_journey_panel.dart \
  lib/shared/widgets/xp_leaderboard_sheet.dart \
  test/student_dashboard_layout_test.dart \
  test/xp_journey_test.dart \
  test/xp_leaderboard_test.dart
git diff --cached --stat
git diff --cached --check
git commit -m "Show 6K milestones and school leaderboard"
git push origin main
xp_release_dir="$(mktemp -d /tmp/focus-xp-release.XXXXXX)"
git archive HEAD | tar -x -C "$xp_release_dir"
cd "$xp_release_dir"
flutter pub get
flutter analyze
flutter test --reporter expanded
flutter build web --release
netlify deploy --dir=build/web --prod --site=574455f0-7d1a-4b99-ab18-18e79d65b648 --message="School XP journey" --json
```

Confirm the Netlify deployment is published to
`https://flexiblelearning.gafarstechnologies.com`, compare public `main.dart.js`
with the built artifact, and verify student/profile/Overall/This week and staff
access. Keep the migration status, deployed revisions and browser checks separate
from the local test results.
