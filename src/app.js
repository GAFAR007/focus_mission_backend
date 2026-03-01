/**
 * WHAT:
 * app.js builds the Express application with security, parsing, routing, and
 * error middleware.
 * WHY:
 * The backend needs one stable composition root so auth, criterion
 * progression, missions, and review flows all share the same middleware
 * boundary.
 * HOW:
 * Register CORS, security middleware, API routes, then attach not-found and
 * error handlers at the end of the chain.
 */
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");

const routes = require("./routes");
const {
  errorHandler,
  notFoundHandler,
} = require("./middleware/error.middleware");

const app = express();
const configuredOrigins = String(process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function normalizeOrigin(origin) {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch (_error) {
    return String(origin || "").trim().replace(/\/+$/, "");
  }
}

function isLocalWebOrigin(origin) {
  try {
    const url = new URL(origin);

    return url.protocol.startsWith("http") &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch (_error) {
    return false;
  }
}

function isAllowedOrigin(origin) {
  const incomingOrigin = normalizeOrigin(origin);
  return configuredOrigins
    .map(normalizeOrigin)
    .some((allowedOrigin) => allowedOrigin === incomingOrigin);
}

app.use(
  cors({
    origin(origin, callback) {
      // WHY: Browsers send an exact origin string; normalize and compare against
      // configured origins so Netlify, localhost, and optional aliases work.
      if (!origin || isAllowedOrigin(origin) || isLocalWebOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS."));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use("/api", routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
