/**
 * WHAT:
 * Route index mounts the backend route groups under the API namespace.
 * WHY:
 * A single route registry keeps the app entrypoint stable as new progression
 * flows are introduced.
 * HOW:
 * Register each route module once and expose the combined router to app.js.
 */
const express = require("express");

const authRoutes = require("./auth.routes");
const criterionRoutes = require("./criterion.routes");
const managementRoutes = require("./management.routes");
const mentorRoutes = require("./mentor.routes");
const notificationRoutes = require("./notification.routes");
const studentRoutes = require("./student.routes");
const systemRoutes = require("./system.routes");
const teacherRoutes = require("./teacher.routes");

const router = express.Router();

router.use("/", systemRoutes);
router.use("/auth", authRoutes);
router.use("/criterion", criterionRoutes);
router.use("/management", managementRoutes);
router.use("/notifications", notificationRoutes);
router.use("/student", studentRoutes);
router.use("/teacher", teacherRoutes);
router.use("/mentor", mentorRoutes);

module.exports = router;
