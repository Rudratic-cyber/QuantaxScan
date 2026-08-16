import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, for the one thing this server does with it: sign a
 * JSON POST to a regional KMS endpoint.
 *
 * ## Why this is here rather than `@aws-sdk/client-kms`
 *
 * Three reasons, in order of weight.
 *
 * **It keeps a customer's secret inside code we can read.** F4's whole contract
 * is that a plaintext exists for the length of one call and is disposed in a
 * `finally`. An SDK client is handed the plaintext and then owns it — its
 * credential provider chain caches, refreshes, and on some paths writes to
 * disk, none of which this codebase can audit and all of which outlive the
 * handle. Sixty lines of HMAC we can read beats a dependency tree we cannot.
 *
 * **SDK errors carry their own input.** §4.6 point 5 is explicit that an SDK
 * error object must never reach `refused[].reason`, a log line, or a response,
 * because cloud SDK errors routinely embed the failing request with headers.
 * This codebase has been bitten twice by exactly that — `routes/credentials.ts`
 * refuses `zod`'s `error.message` because it serialises the rejected input, and
 * `decryptSecret` refuses to chain the crypto error for the same reason. Not
 * having the object at all is a stronger guarantee than remembering not to
 * forward it.
 *
 * **`endpoint` is injectable, so this is testable.** The e2e suite points it at
 * a local stub, exactly as `E2E_CT_STUB_PORT` does for certificate
 * transparency. An SDK would need interception to achieve the same thing.
 *
 * The cost, stated: KMS's API surface here is two actions of a JSON protocol,
 * and this covers only that. Anything needing presigning, STS role assumption,
 * IMDS or S3's signing quirks should not extend this file — it should make the
 * dependency argument on its own merits.
 *
 * Specification: AWS "Signature Version 4 signing process". The canonical
 * request, string-to-sign and signing-key derivation below follow it step for
 * step, and the step names are kept in the comments so it can be checked
 * against the document rather than trusted.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials (STS). Absent for a long-lived key pair. */
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  /** Host header value, e.g. `kms.eu-west-1.amazonaws.com`. Signed, so it must match what is sent. */
  host: string;
  /** Absolute path. `/` for the KMS JSON protocol. */
  path: string;
  region: string;
  service: string;
  /** Already-serialised body. Hashed as-is, so the exact bytes sent must be passed here. */
  body: string;
  /** Extra headers to sign — `x-amz-target` for the JSON protocol. Lowercased keys. */
  headers: Record<string, string>;
  /** Injected so signing is deterministic in a test. */
  now: Date;
}

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string): Buffer => createHmac("sha256", key).update(value, "utf8").digest();

/** `20260816T120000Z` and `20260816`. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Returns the headers to send, including `Authorization`.
 *
 * Every header signed is also returned, which is not a convenience — SigV4
 * fails if the set signed and the set sent differ, and returning one object
 * makes them the same object rather than two lists to keep in step.
 */
export function signAwsRequest(req: SigV4Request, creds: SigV4Credentials): Record<string, string> {
  const { amzDate, dateStamp } = stamps(req.now);
  const payloadHash = sha256Hex(req.body);

  const headers: Record<string, string> = {
    ...req.headers,
    host: req.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    ...(creds.sessionToken === undefined ? {} : { "x-amz-security-token": creds.sessionToken }),
  };

  // Task 1 — canonical request. Headers are sorted by lowercased name, values
  // trimmed, and the signed-header list must be the same set in the same order.
  const sortedNames = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [
    req.method,
    req.path,
    "", // no query string on the KMS JSON protocol
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // Task 2 — string to sign.
  const credentialScope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  // Task 3 — derive the signing key. Chained HMACs, each keyed by the previous
  // digest, so the key is scoped to one date, region and service; a leaked
  // signing key is useless tomorrow and useless elsewhere.
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), req.region), req.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
