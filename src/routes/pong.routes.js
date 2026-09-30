/**
 * WHAT: Registers authenticated Pong and staff access routes.
 * WHY: Student play and teacher administration have different role boundaries.
 * HOW: Existing identity middleware establishes school context before controllers.
 */
const router = require('express').Router();
const { protect, authorizeSourceRoles } = require('../middleware/auth.middleware');
const c = require('../controllers/pong.controller');
router.use(protect);
router.get('/access/:studentId', authorizeSourceRoles('teacher', 'management'), c.getAccess);
router.patch('/access/:studentId', authorizeSourceRoles('teacher', 'management'), c.setAccess);
router.use(authorizeSourceRoles('student'));
router.get('/me', c.me);
router.get('/lobby', c.lobby);
router.post('/challenges', c.challenge);
router.post('/challenges/:handle', c.respond);
router.post('/computer', c.computer);
router.get('/matches/:handle', c.match);
router.get('/matches/:handle/stream', c.stream);
router.post('/matches/:handle/input', c.input);
router.post('/matches/:handle/control', c.control);
router.use(c.error);
module.exports = router;
