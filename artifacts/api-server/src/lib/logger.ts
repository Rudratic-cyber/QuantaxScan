import pino, { type LoggerOptions } from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Exported so a test can build an identical logger over a capture stream.
 *
 * `secret-redaction.test.ts` asserts on what this configuration *actually*
 * emits for real route calls; asserting on the array below would only restate
 * it. The transport is deliberately excluded from the shared value — pino-pretty
 * runs in a worker thread and cannot write to an in-process buffer.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  /**
   * F4 — defence in depth, and it is worth being precise about which depth.
   *
   * `redact` works on **paths within a logged object**. It catches
   * `logger.info({ body })` where the body carries a registration secret, and
   * it catches the request headers above. It cannot catch a secret interpolated
   * into a message string — `logger.info(\`using ${secret}\`)` is opaque to it —
   * and it cannot catch a secret nested at a path nobody listed.
   *
   * So the real control is `SecretHandle` (lib/db/src/credentials.ts), whose
   * coercion hooks make every interpolation render `[redacted]`, plus the rule
   * that route code logs an error's *class* rather than the error object when a
   * secret was in the failing statement. This list is the third layer, for the
   * one shape that is both plausible and mechanical: a request body echoed into
   * a log by a future handler or an error serialiser.
   *
   * `artifacts/api-server/src/secret-redaction.test.ts` captures this logger's
   * real output stream and greps it, rather than trusting the list.
   */
  redact: [
    "req.headers.authorization",
    "req.headers['x-api-key']",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    // The registration body's secret, wherever a serialiser might put it.
    "secret",
    "*.secret",
    "req.body.secret",
    "body.secret",
    "err.body.secret",
    // The stored material. Not the plaintext, but three quarters of what an
    // attacker needs, and a driver error can carry a statement's parameters.
    "ciphertext",
    "*.ciphertext",
  ],
};

export const logger = pino({
  ...loggerOptions,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
