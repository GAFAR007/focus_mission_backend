/**
 * WHAT:
 * db.js opens and monitors the shared MongoDB connection for the backend.
 * WHY:
 * All progression, mission, and review data depends on one predictable
 * database boundary, and startup must fail gracefully when no URI is present.
 * HOW:
 * Read MONGODB_URI from the environment, configure mongoose once, and return
 * the active connection when available with clear, safe diagnostics.
 */
const mongoose = require("mongoose");

const MONGO_SERVER_SELECTION_TIMEOUT_MS = 8000;

function getSafeMongoTarget(mongoUri) {
  try {
    const parsed = new URL(mongoUri);
    const dbName = parsed.pathname?.replace("/", "") || "(default)";
    // WHY: Show host and db only to aid debugging without exposing credentials.
    return `${parsed.protocol}//${parsed.host}/${dbName}`;
  } catch (_error) {
    return "unparseable-mongodb-uri";
  }
}

function getAtlasHostsFromError(error) {
  const topology = error?.reason || error?.cause;
  if (!topology || !(topology.servers instanceof Map)) {
    return [];
  }

  return Array.from(topology.servers.keys());
}

function logMongoConnectionError(error, safeTarget) {
  console.error(`MongoDB connection failed for target: ${safeTarget}`);
  console.error(`MongoDB error: ${error?.name || "UnknownError"}`);
  if (error?.code) {
    console.error(`MongoDB error code: ${error.code}`);
  }
  console.error(error?.message || "No additional error message available.");

  const atlasHosts = getAtlasHostsFromError(error);
  if (atlasHosts.length > 0) {
    console.error(`MongoDB Atlas hosts checked: ${atlasHosts.join(", ")}`);
  }

  if (error?.name === "MongooseServerSelectionError") {
    // WHY: Atlas selection errors are commonly IP whitelist or network related.
    console.error(
      "Action: verify Atlas Network Access allows your current public IP " +
        "or temporarily allow 0.0.0.0/0 for development."
    );
    console.error(
      "Atlas docs: https://www.mongodb.com/docs/atlas/security/ip-access-list/"
    );
  }

  if (error?.code === "ECONNREFUSED" && error?.syscall === "querySrv") {
    // WHY: SRV DNS failures block mongodb+srv even when credentials are valid.
    console.error(
      "Action: your DNS/network is blocking SRV lookups. Check VPN/firewall/" +
        "DNS settings, then retry."
    );
  }
}

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    // WHY: Local documentation or UI work can still run without a database, so
    // startup warns instead of crashing when the environment is incomplete.
    console.warn("MONGODB_URI is not set. API will start without a database.");
    return null;
  }

  mongoose.set("strictQuery", true);
  // WHY: Failing fast on connection issues keeps API errors predictable and
  // avoids long buffering delays when Atlas is unreachable.
  mongoose.set("bufferCommands", false);
  mongoose.set("bufferTimeoutMS", 5000);
  const safeTarget = getSafeMongoTarget(mongoUri);
  console.log(`MongoDB connecting: ${safeTarget}`);

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
    });
  } catch (error) {
    logMongoConnectionError(error, safeTarget);
    throw error;
  }

  const connection = mongoose.connection;
  console.log(
    `MongoDB connected: db=${connection.name} host=${connection.host}:${connection.port}`
  );
  return connection;
}

module.exports = connectDB;
