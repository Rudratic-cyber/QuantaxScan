import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireApiKey } from "./lib/auth";

const app: Express = express();

/**
 * Explicit CORS origin allowlist — closes S4. `origin: true` reflected any
 * requesting origin, which must never ship alongside `credentials: true`.
 *
 * Set CORS_ALLOWED_ORIGINS to a comma-separated list of origins that may call
 * the API cross-origin (the deployed frontend). Same-origin requests are
 * unaffected by CORS and need no entry.
 */
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter((origin) => origin.length > 0);

if (allowedOrigins.length === 0) {
  logger.warn(
    "CORS_ALLOWED_ORIGINS is not set; cross-origin browser requests will be refused",
  );
}

const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    // Requests without an Origin header (curl, server-to-server) are not
    // subject to CORS; the API key is what protects those.
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, allowedOrigins.includes(origin.replace(/\/+$/, "")));
  },
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
};

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// cors() must stay ahead of requireApiKey so OPTIONS preflight terminates here
// rather than being rejected with a 401.
app.use(cors(corsOptions));

// Authenticate before the body parsers, so an unauthenticated request is
// rejected without first buffering and parsing up to 10 MB of JSON.
app.use("/api", requireApiKey);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/api", router);

export default app;
