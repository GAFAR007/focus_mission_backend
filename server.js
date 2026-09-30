/**
 * WHAT:
 * server.js bootstraps database connection, HTTP listener startup, and
 * background reliability workers.
 * WHY:
 * Result email delivery uses retry semantics, so worker startup must happen
 * once after a successful DB connection.
 * HOW:
 * Check production release evidence, connect MongoDB, start the retry worker,
 * then bind the Express app.
 */
require("dotenv").config();

// WHY: Direct Render startup must enforce the same guard as npm start, before
// touching production data or accepting requests. Development never bumps versions.
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  require('./src/utils/releaseGuard').checkRelease();
}

const app = require("./src/app");
const connectDB = require("./src/config/db");
const { startResultEmailRetryWorker } = require("./src/services/result.service");

const PORT = Number(process.env.PORT) || 4000;

async function startServer() {
  await connectDB();
  if (require("mongoose").connection.readyState === 1) {
    await require("./src/services/school.service").migrateCurrentSchool();
  }
  startResultEmailRetryWorker();

  app.listen(PORT, () => {
    console.log(`Focus Mission backend listening on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
