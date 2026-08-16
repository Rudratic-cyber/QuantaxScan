import type { DiscoveryScope, DiscoveryTargetKind, EnumeratedScope, RefusedScope } from "@workspace/collectors";
import type { SecretHandle } from "@workspace/db/credentials";
import type { AcquisitionRequest, AcquisitionResult } from "./types";
import { signAwsRequest, type SigV4Credentials } from "./aws-sigv4";

/**
 * P2 — enumerate an AWS account's S3 buckets as **leads**, with the customer's
 * own read-only credential.
 * docs/Claude/17-discovery-design.md §3.2 item 3, §1.2.
 *
 * ## What a lead is, and what it is emphatically not
 *
 * The first invariant D8 established, which every source inherits: **a
 * discovery source writes no `assets`, no `observations` and no
 * `collection_runs` row, and introduces no `Surface` value, no fingerprint case
 * and no `location_detail` kind.** Discovery examines nothing. A bucket name is
 * a place a collector *could* look; until B7 reads its encryption
 * configuration, this product knows nothing about the cryptography behind it —
 * not a cipher, not a key-wrapping algorithm, not whether it is encrypted at
 * all.
 *
 * So nothing here produces an observation, and the e2e assertion that guards it
 * requires every surface to still read `never-examined` after a discovery run.
 *
 * ## Why buckets rather than load balancers
 *
 * §3.2 orders load balancers second and storage third. Storage goes first here
 * for a reason the ordering rule itself supports: `data-at-rest` is *"the true
 * HNDL surface"*, and `ListBuckets` is one unpaginated global call, which makes
 * it the cheapest possible proof that credentialed enumeration writes leads and
 * not assets. The ordering is about value, and this is about establishing the
 * mechanism; the second resource type is a function, not a redesign.
 *
 * ## The identity is the bucket name, and there is no hostname
 *
 * A bucket has a DNS name — `<bucket>.s3.amazonaws.com` — and this
 * deliberately does not record one. **We would be constructing it**, and
 * `normaliseHostname()`'s rule is that this product never fixes a name into
 * something plausible, because a repaired name is a name nobody has evidence
 * for. AWS returned a bucket name; that is what gets stored. `hostname` stays
 * NULL, which is exactly the state stage 0 made expressible.
 */

const ENDPOINT_OVERRIDE = process.env.AWS_S3_ENDPOINT;

/** `ListBuckets` is a global call. AWS requires it signed for `us-east-1` regardless of where the buckets live. */
const SIGNING_REGION = "us-east-1";

const CALL_TIMEOUT_MS = 15_000;

/** One lead, before it becomes a `discovered_targets` row. */
export interface CloudLead {
  identity: string;
  targetKind: DiscoveryTargetKind;
  /** Present only where the resource genuinely has a DNS name. A bucket does not — see the header. */
  hostname?: string;
  /** Exactly what the provider said, and nothing derived from it. */
  evidence: Record<string, unknown>;
}

interface AwsSecretShape {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Shared with the KMS acquisition's rule: `JSON.parse`'s message quotes the input, so it is never propagated. */
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

function refusalFor(status: number | null, errName: string | null): RefusedScope["reason"] {
  if (status === null) return errName === "AbortError" ? "timeout" : "unreachable";
  if (status === 403 || status === 401) return "access-denied";
  if (status === 400) return "unauthenticated";
  if (status === 429 || status === 503) return "throttled";
  if (status === 404 || status === 501) return "unsupported";
  return "unreachable";
}

/**
 * Pull bucket names out of the `ListBuckets` XML.
 *
 * **A deliberate minimum, and its limits are stated rather than implied.** S3's
 * response is a fixed, flat, unpaginated document of the form
 * `<Buckets><Bucket><Name>x</Name><CreationDate>…</CreationDate></Bucket>…`,
 * with no attributes, no namespaces on the elements read, and no nesting inside
 * `<Name>`. A regex over that is sufficient and adds no dependency to a server
 * that otherwise parses no XML at all.
 *
 * What it would get wrong, so nobody assumes otherwise: any XML where `<Name>`
 * can nest, repeat inside another element, or carry entities beyond the four
 * decoded below. If a second S3 call is ever added whose response is paginated
 * or nested — `ListObjectsV2` is both — this function must not be reused for
 * it; that call needs a real parser and should bring one.
 *
 * Entity decoding is limited to the five XML predefined entities, applied once
 * and not recursively, so an encoded entity cannot be decoded into a different
 * one.
 */
export function parseBucketNames(xml: string): string[] {
  const names: string[] = [];
  const pattern = /<Name>([^<]*)<\/Name>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const raw = match[1];
    if (raw === undefined || raw === "") continue;
    names.push(
      raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) =>
        entity === "amp" ? "&" : entity === "lt" ? "<" : entity === "gt" ? ">" : entity === "quot" ? '"' : "'",
      ),
    );
  }
  return names;
}

async function listBuckets(
  creds: SigV4Credentials,
  now: Date,
): Promise<{ ok: true; xml: string } | { ok: false; reason: RefusedScope["reason"] }> {
  const host = ENDPOINT_OVERRIDE ? new URL(ENDPOINT_OVERRIDE).host : "s3.amazonaws.com";
  const origin = ENDPOINT_OVERRIDE ?? `https://${host}`;

  const headers = signAwsRequest(
    { method: "GET", host, path: "/", region: SIGNING_REGION, service: "s3", body: "", headers: {}, now },
    creds,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/`, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) return { ok: false, reason: refusalFor(res.status, null) };
    return { ok: true, xml: await res.text() };
  } catch (err) {
    // Name only. Never the message, never the object — an S3 error body quotes
    // the request that failed. §4.6 point 5.
    return { ok: false, reason: refusalFor(null, err instanceof Error ? err.name : null) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enumerate the buckets an AWS credential can see.
 *
 * `ListBuckets` is account-wide and returns every bucket regardless of region,
 * so the scope this can claim is the **account**, with no region — and the
 * enumerated scope it records says so rather than naming a region it never
 * filtered on. Claiming a region here would be the §4.5 corollary violated in
 * the opposite direction: over-narrow is harmless, over-broad retires things.
 */
export async function acquireS3Leads(
  secret: SecretHandle,
  request: AcquisitionRequest,
): Promise<AcquisitionResult<CloudLead[]>> {
  const enumerated: EnumeratedScope[] = [];
  const refused: RefusedScope[] = [];
  const leads: CloudLead[] = [];
  let truncated = false;
  const now = new Date();

  const creds = parseAwsSecret(secret.reveal());
  if (creds === null) {
    for (const scope of request.scopes) {
      refused.push({ scope, reason: "unauthenticated", detail: "credential is not a JSON AWS key pair" });
    }
    return { input: [], enumerated, refused, truncated: false };
  }

  for (const scope of request.scopes) {
    if (scope.kind !== "cloud_account" || scope.provider !== "aws") {
      refused.push({ scope, reason: "unsupported", detail: "this acquisition enumerates AWS S3 only" });
      continue;
    }

    const listed = await listBuckets(creds, now);
    if (!listed.ok) {
      refused.push({ scope, reason: listed.reason });
      continue;
    }

    const names = parseBucketNames(listed.xml);
    const room = request.maxItems - leads.length;
    const taken = names.slice(0, Math.max(0, room));

    for (const name of taken) {
      leads.push({
        identity: name,
        // `cloud_resource`, from stage 0's existing tuple. The tempting move is
        // to widen it with a `data_store` value so the lead names what B7 will
        // read — and that is the wrong reason to widen a vocabulary. The kind
        // says how to read `identity`, and a bucket name is read exactly like
        // any other cloud resource name. Which collector should examine it is a
        // different question, answered by the evidence's `service`.
        targetKind: "cloud_resource",
        // No hostname. See the header — we would be constructing it.
        evidence: { provider: "aws", service: "s3", account: scope.account, bucket: name },
      });
    }

    if (taken.length < names.length) {
      // The ceiling was reached, so this account was NOT enumerated: reporting
      // it as complete while withholding names is the precise lie
      // `MAX_DISCOVERED_HOSTNAMES_PER_RUN`'s rule exists to prevent.
      truncated = true;
      refused.push({ scope, reason: "throttled", detail: "ceiling reached before the account was exhausted" });
      continue;
    }

    enumerated.push({
      scope: { kind: "cloud_account", provider: "aws", account: scope.account, service: "s3" },
      complete: true,
    });
  }

  return { input: leads, enumerated, refused, truncated };
}

export const __testing = { parseAwsSecret, refusalFor };
