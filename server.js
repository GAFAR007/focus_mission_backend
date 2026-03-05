/**
 * WHAT:
 * server.js bootstraps database connection, HTTP listener startup, and
 * background reliability workers.
 * WHY:
 * Result email delivery uses retry semantics, so worker startup must happen
 * once after a successful DB connection.
 * HOW:
 * Connect MongoDB first, start retry worker, then bind the Express app.
 */
require("dotenv").config();

const app = require("./src/app");
const connectDB = require("./src/config/db");
const { startResultEmailRetryWorker } = require("./src/services/result.service");

const PORT = Number(process.env.PORT) || 4000;

async function startServer() {
  await connectDB();
  startResultEmailRetryWorker();

  app.listen(PORT, () => {
    console.log(`Focus Mission backend listening on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
