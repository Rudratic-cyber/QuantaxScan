import type { KmsKeyDescription } from "@workspace/collectors";
import type { DiscoveryScope, EnumeratedScope, RefusedScope } from "@workspace/collectors";
import type { SecretHandle } from "@workspace/db/credentials";
import type { Acquisition, AcquisitionRequest, AcquisitionResult } from "./types";
import { signAwsRequest, type SigV4Credentials } from "./aws-sigv4";

/**
 * P1 — read an AWS account's KMS keys with the customer's own read-only
 * credential, and produce exactly the shape B5's collector already takes.
 * docs/Claude/17-discovery-design.md §3.2 item 1, §4.3.
 *
 * **The cheapest demonstration in the plan that the model works**, and chosen
 * first for that reason: zero new credential kinds (`cloud_kms_readonly`
 * already existed for this), zero new collector code, and the API responses are
 * a transcription of what `KmsKeyDescription` already models — B5's own header
 * says a credentialed poller *"is a strictly additive follow-up that produces
 * the same `KmsKeyDescription` values this file already maps."*
 *
 * ## What it does and does not claim
 *
 * A scope reaches `enumerated` only when its pagination is **exhausted** and no
 * call failed. Anything else is a `RefusedScope` with a reason from the closed
 * vocabulary. That distinction is not bookkeeping: §4.5 makes a prefix
 * reobservation scope — the thing that can retire keys — conditional on it, and
 * the failure it prevents is the worst available here. A throttled second page
 * of `ListKeys`, treated as a complete enumeration, retires every key it did not
 * see and the drift feed reports a mass remediation nobody performed.
 *
 * **Provider soft-deletion is not absence.** `PendingDeletion` and `Disabled`
 * keys are still returned by a complete enumeration and are passed through with
 * their `keyState`; the collector already models it. A key that vanishes from a
 * complete enumeration is gone, a key returned as `PendingDeletion` is present
 * and disabled, and conflating them puts a live key's retirement a month early.
 */

/** `kms.<region>.amazonaws.com`, unless a test points it somewhere else. */
const ENDPOINT_OVERRIDE = process.env.AWS_KMS_ENDPOINT;

/**
 * Regions are caller-supplied and interpolated into a hostname, which makes
 * this an SSRF surface — the same one `tls-ssrf-guard.ts` exists for on B3.
 * A strict allowlist pattern is the cheap half of the answer: AWS region codes
 * are `[a-z]+-[a-z]+-\d+` with an optional extra segment (`us-gov-west-1`,
 * `ap-southeast-3`), and nothing that matches this can carry a `/`, a `@`, a
 * `:` or a second host.
 */
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+){1,2}-\d$/;

/** How long one provider call may take before it is `timeout` rather than an unknown. */
const CALL_TIMEOUT_MS = 15_000;

/**
 * A page ceiling, so a misconfigured or enormous account cannot spin here
 * forever. Distinct from `AcquisitionRequest.maxItems`, which bounds *keys*:
 * this bounds *round trips*, and either being hit sets `truncated`.
 *
 * §7 Q6 is open on what the right number is — the existing precedents
 * (`MAX_DISCOVERED_HOSTNAMES_PER_RUN`, `MAX_SCHEDULES_PER_RUN`) bound our work,
 * while this also bounds the customer's bill and their API rate limits, and
 * settling it needs a real account. Until then a low ceiling with `truncated:
 * true` is at least honest.
 */
const MAX_PAGES = 20;

/**
 * What we expect a `cloud_kms_readonly` secret to contain for AWS.
 *
 * JSON rather than a delimited string so a secret access key containing the
 * delimiter cannot silently truncate the credential — a failure that would
 * present as an opaque 403 from the vendor and send somebody looking in the
 * wrong place entirely.
 */
interface AwsSecretShape {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Reads the plaintext into credentials, and **throws nothing that contains it.**
 *
 * `JSON.parse`'s own error message quotes the input around the failure
 * position, which for a malformed secret is the secret. The same rule
 * `routes/credentials.ts` follows in refusing `zod`'s `error.message`, and
 * `decryptSecret` in refusing to chain the crypto error.
 */
function parseAwsSecret(plaintext: string): SigV4Credentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<AwsSecretShape>;
  if (typeof candidate.accessKeyId !== "string" || typeof candidate.secretAccessKey !== "string") return null;
  return {
    accessKeyId: candidate.accessKeyId,
    secretAccessKey: candidate.secretAccessKey,
    ...(typeof candidate.sessionToken === "string" ? { sessionToken: candidate.sessionToken } : {}),
  };
}

/**
 * Map a transport or HTTP failure onto the closed refusal vocabulary.
 *
 * **Takes a status and a name, never an error object**, so there is no path by
 * which a vendor message — which may quote the request that failed, headers
 * included — reaches a stored row or a response body. §4.6 point 5.
 */
function refusalFor(status: number | null, errName: string | null): RefusedScope["reason"] {
  if (status === null) return errName === "AbortError" ? "timeout" : "unreachable";
  if (status === 403 || status === 401) return "access-denied";
  if (status === 400) return "unauthenticated";
  if (status === 429 || status === 503) return "throttled";
  if (status === 404 || status === 501) return "unsupported";
  return "unreachable";
}

interface KmsCall {
  target: "TrentService.ListKeys" | "TrentService.DescribeKey";
  payload: Record<string, unknown>;
}

async function callKms(
  region: string,
  creds: SigV4Credentials,
  call: KmsCall,
  now: Date,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: RefusedScope["reason"] }> {
  const host = ENDPOINT_OVERRIDE ? new URL(ENDPOINT_OVERRIDE).host : `kms.${region}.amazonaws.com`;
  const origin = ENDPOINT_OVERRIDE ?? `https://${host}`;
  const body = JSON.stringify(call.payload);

  const headers = signAwsRequest(
    {
      method: "POST",
      host,
      path: "/",
      region,
      service: "kms",
      body,
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": call.target },
      now,
    },
    creds,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/`, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) return { ok: false, reason: refusalFor(res.status, null) };
    return { ok: true, body: (await res.json()) as Record<string, unknown> };
  } catch (err) {
    // Only the error's *name* is read. Never its message, never the object.
    const name = err instanceof Error ? err.name : null;
    return { ok: false, reason: refusalFor(null, name) };
  } finally {
    clearTimeout(timer);
  }
}

function describeToKey(region: string, metadata: Record<string, unknown>): KmsKeyDescription | null {
  const keyId = typeof metadata.Arn === "string" ? metadata.Arn : typeof metadata.KeyId === "string" ? metadata.KeyId : null;
  if (keyId === null) return null;

  // Every field is present only when AWS stated it. An absent value stays
  // absent rather than becoming a placeholder — the collector treats a missing
  // `keySpec` as `no-spec` and says so, which is a better outcome than a
  // guessed spec that resolves to a confident wrong algorithm.
  return {
    // The collector's vocabulary, not AWS's. `KMS_PROVIDER_VALUES` names the
    // product, not the cloud — `aws-kms` rather than `aws` — because a single
    // provider can run more than one key service.
    provider: "aws-kms",
    keyId,
    ...(typeof metadata.KeySpec === "string" ? { keySpec: metadata.KeySpec } : {}),
    ...(typeof metadata.KeyState === "string" ? { keyState: metadata.KeyState } : {}),
    ...(typeof metadata.Origin === "string" ? { origin: metadata.Origin } : {}),
    ...(typeof metadata.CustomKeyStoreId === "string" ? { keyStore: metadata.CustomKeyStoreId } : {}),
    region,
  };
}

/**
 * Enumerate one region's KMS keys.
 *
 * Returns the keys it read *and* whether the region was fully enumerated, as
 * two separate facts. A partial read still yields real keys — they were
 * observed and it would be wasteful and dishonest to discard them — but it must
 * not license retiring anything, so completeness travels separately rather than
 * being inferred from a non-empty list.
 */
async function enumerateRegion(
  scope: Extract<DiscoveryScope, { kind: "cloud_account" }>,
  creds: SigV4Credentials,
  remaining: number,
  now: Date,
): Promise<{ keys: KmsKeyDescription[]; complete: boolean; reason?: RefusedScope["reason"]; truncated: boolean }> {
  const region = scope.region;
  if (region === undefined || !REGION_PATTERN.test(region)) {
    // Refused rather than defaulted. Guessing `us-east-1` for a caller who
    // named no region would enumerate the wrong place and then claim it as
    // coverage of the account.
    return { keys: [], complete: false, reason: "unsupported", truncated: false };
  }

  const keys: KmsKeyDescription[] = [];
  let marker: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await callKms(region, creds, {
      target: "TrentService.ListKeys",
      payload: { Limit: 100, ...(marker === undefined ? {} : { Marker: marker }) },
    }, now);
    if (!list.ok) return { keys, complete: false, reason: list.reason, truncated };

    const entries = Array.isArray(list.body.Keys) ? (list.body.Keys as Array<Record<string, unknown>>) : [];
    for (const entry of entries) {
      const id = typeof entry.KeyArn === "string" ? entry.KeyArn : typeof entry.KeyId === "string" ? entry.KeyId : null;
      if (id === null) continue;

      if (keys.length >= remaining) {
        // The ceiling is reported, never silent. A silently trimmed list would
        // make "we enumerated your account" false in exactly the number this
        // whole feature exists to make honest.
        return { keys, complete: false, reason: undefined, truncated: true };
      }

      const described = await callKms(region, creds, {
        target: "TrentService.DescribeKey",
        payload: { KeyId: id },
      }, now);
      if (!described.ok) return { keys, complete: false, reason: described.reason, truncated };

      const metadata = described.body.KeyMetadata;
      if (metadata !== null && typeof metadata === "object") {
        const key = describeToKey(region, metadata as Record<string, unknown>);
        if (key !== null) keys.push(key);
      }
    }

    const next = list.body.NextMarker;
    if (list.body.Truncated !== true || typeof next !== "string") {
      // Pagination exhausted with no error: this region is genuinely complete.
      return { keys, complete: true, truncated };
    }
    marker = next;
  }

  // Ran out of pages rather than out of keys.
  return { keys, complete: false, truncated: true };
}

export const awsKmsAcquisition: Acquisition<KmsKeyDescription[]> = {
  // Distinct from the submission path's `"kms-inventory"`, and that is one of
  // the three places the poll-versus-submission distinction is allowed to live
  // (§4.2). It becomes `collection_runs.collector`, so a run is attributable to
  // how it was acquired without reading its enumeration record.
  name: "kms-poll-aws",
  version: "1.0.0",
  surface: "kms",
  credentialKind: "cloud_kms_readonly",

  async acquire(secret: SecretHandle, request: AcquisitionRequest): Promise<AcquisitionResult<KmsKeyDescription[]>> {
    const enumerated: EnumeratedScope[] = [];
    const refused: RefusedScope[] = [];
    const keys: KmsKeyDescription[] = [];
    let truncated = false;
    const now = new Date();

    // Revealed once, as late as possible, and never returned from this function
    // or anything it calls. §4.6 point 4.
    const creds = parseAwsSecret(secret.reveal());
    if (creds === null) {
      // Every scope is refused, individually, so the run records which scopes
      // were *asked for* rather than collapsing to one opaque failure. The
      // reason names the credential, not its contents.
      for (const scope of request.scopes) {
        refused.push({ scope, reason: "unauthenticated", detail: "credential is not a JSON AWS key pair" });
      }
      return { input: [], enumerated, refused, truncated: false };
    }

    for (const scope of request.scopes) {
      if (scope.kind !== "cloud_account" || scope.provider !== "aws") {
        refused.push({ scope, reason: "unsupported", detail: "this acquisition reads AWS KMS only" });
        continue;
      }

      const result = await enumerateRegion(scope, creds, request.maxItems - keys.length, now);
      keys.push(...result.keys);
      if (result.truncated) truncated = true;

      if (result.complete) {
        // Recorded at the granularity the prefix will be taken at — the region,
        // never the account. "Enumerated the AWS account" does not license
        // retiring keys in a region that was never called. §4.5.
        enumerated.push({
          scope: { kind: "cloud_account", provider: "aws", account: scope.account, region: scope.region, service: "kms" },
          complete: true,
        });
      } else if (result.reason !== undefined) {
        refused.push({ scope, reason: result.reason });
      } else {
        refused.push({ scope, reason: "throttled", detail: "ceiling reached before the scope was exhausted" });
      }
    }

    // Account ids, ARNs, regions and key specs are all fine to return. A
    // session token, a signed header, a presigned URL or an SDK error object
    // would not be — and none of them exists past this point. §4.6 point 5.
    return { input: keys, enumerated, refused, truncated };
  },
};

/** Exported for the acquisition's unit tests, which have no business reaching into a closure. */
export const __testing = { parseAwsSecret, refusalFor, describeToKey, REGION_PATTERN, MAX_PAGES };
