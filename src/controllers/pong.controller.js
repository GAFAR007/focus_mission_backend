/**
 * WHAT: Validates Pong requests and exposes safe response shapes.
 * WHY: Clients supply only controls and choices, never school, scores or wins.
 * HOW: Strict payload allowlists delegate to scoped game services.
 */
const mongoose = require('mongoose');
const service = require('../services/pong.service');
const runtime = require('../services/pongRuntime.service');
const bad = () => service.fail(400, 'PONG_INVALID_INPUT', 'Check the game request and try again.');
function body(req, keys) {
  const value = req.body || {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw bad();
  return value;
}
function handle(value) { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw bad(); return value; }
const route = fn => async (req, res, next) => { try { const data = await fn(req, res); if (!res.headersSent) res.json(data); } catch (error) { next(error); } };
exports.me = route(req => service.me(req.user.id));
exports.lobby = route(req => {
  const search = req.query.search || '';
  if (typeof search !== 'string' || search.length > 60) throw bad();
  return service.lobby(req.user.id, search);
});
exports.challenge = route(req => {
  const data = body(req, ['opponent', 'rematchOf', 'ruleset']);
  return service.challenge(req.user.id, handle(data.opponent), data.rematchOf ? handle(data.rematchOf) : null, data.ruleset || 'classic');
});
exports.respond = route(req => {
  const data = body(req, ['action', 'ruleset']);
  if (data.ruleset != null && !['classic', 'power'].includes(data.ruleset)) throw bad();
  if (!['accept', 'decline', 'cancel'].includes(data.action)) throw bad();
  return service.respond(req.user.id, handle(req.params.handle), data.action, data.ruleset);
});
exports.computer = route(req => {
  const data = body(req, ['level']);
  if (!Number.isInteger(data.level) || data.level < 1 || data.level > 15) throw bad();
  return service.startComputer(req.user.id, data.level);
});
exports.match = route(async req => service.matchView(req.user.id, await service.ownedMatch(req.user.id, handle(req.params.handle))));
exports.stream = route((req, res) => runtime.connect(req.user.id, handle(req.params.handle), res));
exports.input = route(req => {
  const data = body(req, ['controlToken', 'seq', 'direction', 'targetY', 'forward']);
  handle(data.controlToken);
  if (!Number.isSafeInteger(data.seq) || data.seq < 0) throw bad();
  if (data.direction != null && ![-1, 0, 1].includes(data.direction)) throw bad();
  if (data.forward != null && ![-1, 0, 1].includes(data.forward)) throw bad();
  if (data.targetY != null && (!Number.isFinite(data.targetY) || data.targetY < 0 || data.targetY > 560)) throw bad();
  return runtime.input(req.user.id, handle(req.params.handle), data);
});
exports.control = route(req => {
  const data = body(req, ['action']);
  if (!['pause', 'resume', 'leave'].includes(data.action)) throw bad();
  return runtime.control(req.user.id, handle(req.params.handle), data.action);
});
function student(req) { if (!mongoose.isValidObjectId(req.params.studentId)) throw bad(); return req.params.studentId; }
exports.getAccess = route(req => service.getAccess(req.user.id, student(req)));
exports.setAccess = route(req => {
  const data = body(req, ['enabled', 'computer', 'battles', 'powerBattle', 'lobbyVisible']);
  if (!Object.keys(data).length || Object.values(data).some(v => typeof v !== 'boolean')) throw bad();
  return service.setAccess(req.user.id, student(req), data);
});
exports.error = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.code === 11000 ? 409 : error.statusCode || 500;
  res.status(status).json({ success: false, code: typeof error.code === 'string' ? error.code : status === 409 ? 'PONG_CONFLICT' : 'PONG_ERROR',
    message: status >= 500 ? 'The game is temporarily unavailable. Please try again.' : error.code === 11000 ? 'A challenge is already waiting.' : error.message });
};
