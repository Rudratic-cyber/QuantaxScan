import tls from "node:tls";
import type { TlsHandshakeResult } from "@workspace/collectors";
import { resolveAndValidateTarget, TargetRejectedError } from "./tls-ssrf-guard";
import { logger } from "./logger";

/**
 * B3's I/O half — the `node:tls` connection itself. `tls-collector.ts`
 * (`@workspace/collectors`) is the pure mapping from a completed handshake to
 * `RawObservation`s and has no socket code at all; this is the only place in
 * the whole feature that opens one, and every connection it opens has already
 * been through {@link resolveAndValidateTarget} — see `tls-ssrf-guard.ts` for
 * why that ordering, not "validate the hostname and let `tls.connect`
 * re-resolve it," is what actually closes the SSRF/rebinding gap.
 */

/** A per-attempt ceiling — this connects to a caller-named host, which may simply not answer. */
export const TLS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Hard cap on one submission's target list, mirroring
 * `MAX_LOCKFILES_PER_SUBMISSION` in `routes/projects.ts`. Enforced at the
 * schema level (`SubmitProjectTlsBody.targets`'s `maxItems` in
 * `lib/api-spec/openapi.yaml`) rather than here — this constant exists so the
 * two stay documented as the same number rather than drifting; if either
 * changes, change both.
 */
export const MAX_TLS_TARGETS_PER_SUBMISSION = 20;

/** Probes in flight at once. Small on purpose: this is outbound egress to hosts this server does not control, not local CPU work like the scan routes. */
export const TLS_PROBE_CONCURRENCY = 4;

export type TlsProbeOutcome =
  | { host: string; port: number; outcome: "probed"; handshake: TlsHandshakeResult }
  | { host: string; port: number; outcome: "refused"; reason: "invalid-hostname" | "blocked-address" | "dns-resolution-failed" }
  | { host: string; port: number; outcome: "unreachable" };

/**
 * `getEphemeralKeyInfo()` is populated by Node for TLS ≤ 1.2 and returns `{}`
 * for TLS 1.3 — verified empirically against Node v24.14.0 (`tls.connect` to
 * a local self-signed `tls.createServer`, forcing `maxVersion: "TLSv1.2"`
 * makes `type`/`name`/`size` all populated; the same connection allowed to
 * negotiate TLS 1.3 reports `{ type: undefined, name: undefined, size:
 * undefined }`). This is a known Node limitation
 * (nodejs/node#44322), not a bug introduced here.
 *
 * TLS 1.3 mandates an ephemeral (EC)DHE exchange for every one of its five
 * cipher suites (RFC 8446 §1: "all handshakes now use an (EC)DHE key
 * exchange"), so this collector still knows an exchange happened even when
 * Node cannot say which group — reporting `type: "ECDH"` with `name`/`bits`
 * left undefined is the honest middle ground: not silence (which would wrongly
 * imply a static-RSA exchange, the actual "no keyExchange" case), and not a
 * fabricated group name.
 */
function keyExchangeFrom(socket: tls.TLSSocket, protocolVersion: string): TlsHandshakeResult["keyExchange"] {
  // `getEphemeralKeyInfo()`'s return type is `object | EphemeralKeyInfo` —
  // the empty case (nothing to report) is typed as a bare `object`, so a
  // property access needs this guard rather than an `.type` truthiness
  // check TypeScript can see through.
  const ephemeral = socket.getEphemeralKeyInfo();
  if (ephemeral && "type" in ephemeral && ephemeral.type) {
    return {
      type: ephemeral.type as "ECDH" | "DH",
      name: "name" in ephemeral && typeof ephemeral.name === "string" ? ephemeral.name : undefined,
      bits: "size" in ephemeral && typeof ephemeral.size === "number" ? ephemeral.size : undefined,
    };
  }
  if (protocolVersion === "TLSv1.3") {
    return { type: "ECDH" };
  }
  // TLS <= 1.2 and Node reports no ephemeral key at all: a genuinely
  // non-forward-secret (static key transport) cipher was negotiated.
  return undefined;
}

function peerCertificatePublicKeyFrom(socket: tls.TLSSocket): TlsHandshakeResult["peerCertificatePublicKey"] {
  let cert: ReturnType<tls.TLSSocket["getPeerX509Certificate"]>;
  try {
    cert = socket.getPeerX509Certificate();
  } catch {
    return undefined;
  }
  if (!cert) return undefined;
  const pubkey = cert.publicKey;
  const keyType = pubkey.asymmetricKeyType;
  if (!keyType) return undefined;
  const details = pubkey.asymmetricKeyDetails ?? {};
  return {
    keyType,
    modulusBits: typeof details.modulusLength === "number" ? details.modulusLength : undefined,
    namedCurve: typeof details.namedCurve === "string" ? details.namedCurve : undefined,
  };
}

/**
 * Opens exactly one TLS connection to an already-resolved, already-validated
 * address and reports what was negotiated. Never verifies trust — this
 * collector observes what algorithm a host presents, not whether a browser
 * would accept it, so `rejectUnauthorized: false` is a deliberate posture,
 * not an oversight: refusing self-signed/expired/mismatched certificates
 * would make the prober blind to exactly the misconfigured estates this
 * product exists to find, and B4 (certificate validity) is the surface that
 * judges trust, not this one.
 */
function probeOne(target: { host: string; address: string; port: number }): Promise<TlsHandshakeResult> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: target.address,
        port: target.port,
        // SNI and certificate hostname checks use the name the caller gave,
        // never the pinned IP — otherwise every probe would present (and
        // validate against) a bare IP SNI, which is not what "probe
        // example.com:443" means.
        servername: target.host,
        rejectUnauthorized: false,
        timeout: TLS_PROBE_TIMEOUT_MS,
      },
      () => {
        clearTimeout(timer);
        const protocolVersion = socket.getProtocol() ?? "unknown";
        const cipher = socket.getCipher();
        const result: TlsHandshakeResult = {
          host: target.host,
          port: target.port,
          protocolVersion,
          cipherSuiteName: cipher.standardName ?? cipher.name,
          keyExchange: keyExchangeFrom(socket, protocolVersion),
          peerCertificatePublicKey: peerCertificatePublicKeyFrom(socket),
        };
        socket.end();
        resolve(result);
      },
    );

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, TLS_PROBE_TIMEOUT_MS);

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("timeout", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("timed out"));
    });
  });
}

/** Runs `fn` over `items` with at most `limit` in flight — no dependency added for four lines of scheduling. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Probes every target, guard-checked first. A target the guard refuses never
 * reaches a socket; one that times out or is refused by the remote end is
 * reported as `unreachable` rather than throwing, so one bad host in a batch
 * does not fail the whole submission.
 */
export async function probeTlsTargets(
  targets: Array<{ host: string; port: number }>,
): Promise<TlsProbeOutcome[]> {
  return mapWithConcurrency(targets, TLS_PROBE_CONCURRENCY, async (t): Promise<TlsProbeOutcome> => {
    let resolved: Awaited<ReturnType<typeof resolveAndValidateTarget>>;
    try {
      resolved = await resolveAndValidateTarget(t.host, t.port);
    } catch (err) {
      if (err instanceof TargetRejectedError) {
        return { host: t.host, port: t.port, outcome: "refused", reason: err.reason };
      }
      throw err;
    }

    try {
      const handshake = await probeOne(resolved);
      return { host: t.host, port: t.port, outcome: "probed", handshake };
    } catch (err) {
      logger.warn({ host: t.host, port: t.port, err: err instanceof Error ? err.message : String(err) }, "TLS probe did not complete");
      return { host: t.host, port: t.port, outcome: "unreachable" };
    }
  });
}
