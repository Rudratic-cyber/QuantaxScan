/**
 * A real TLS server on loopback, for B3's prober to genuinely handshake against.
 *
 * The e2e suite's rule is that nothing fabricates a response, and for the TLS
 * prober that means the thing on the other end of the socket has to be a real
 * TLS implementation completing a real handshake — `tls.createServer`, not a
 * stub that returns a canned `TlsHandshakeResult`. A mocked handshake would
 * assert that our own mapping code can be called, which `tls-collector.test.ts`
 * already proves, and would say nothing about whether `tls-probe.ts` reads the
 * right things off a live `TLSSocket`.
 *
 * ## Why this shells out to `openssl`
 *
 * `node:crypto` can *parse* an X.509 certificate (`X509Certificate`) and can
 * generate a key pair, but it cannot sign a certificate — there is no
 * certificate-creation API in Node at all. The alternatives were a
 * third-party certificate library (a dependency added for one test file) or a
 * committed key/cert pair. A committed pair was rejected for the same reason
 * `config.ts` generates the API key per run rather than committing one: a key
 * in the repository is a key in the repository, even a throwaway one, and a
 * fixture certificate would additionally expire one day and fail this suite
 * for a reason unrelated to the code under test. `openssl` is already required
 * on any machine that can run this stack.
 *
 * The certificate is self-signed and that is deliberate — `tls-probe.ts`
 * connects with `rejectUnauthorized: false` on purpose, because the prober
 * observes what a host negotiates rather than whether a browser would trust
 * it. A self-signed peer is therefore exactly the case it must handle.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { HOST } from "./config";

export interface TlsTestServer {
  /** The ephemeral port the server actually bound to. */
  port: number;
  close: () => Promise<void>;
}

export interface TlsTestServerOptions {
  /**
   * RSA modulus size for the server certificate's key. The prober reports this
   * verbatim as the asset's key size, so a spec that asserts on a specific
   * number needs to be the thing that chose it.
   */
  rsaModulusBits?: number;
  /** Pin the protocol version, e.g. to exercise the TLS 1.2 branch of `keyExchangeFrom`. */
  maxVersion?: tls.SecureVersion;
}

function selfSignedPair(rsaModulusBits: number): { key: string; cert: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "qx-e2e-tls-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");

  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      `rsa:${rsaModulusBits}`,
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=quantaxscan-e2e-tls.invalid/O=QuantaXscan e2e",
    ],
    { stdio: "pipe" },
  );

  return {
    key: readFileSync(keyPath, "utf8"),
    cert: readFileSync(certPath, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Starts a TLS server on an ephemeral loopback port and resolves once it is
 * genuinely listening. Binds to {@link HOST} (`127.0.0.1`) rather than
 * `localhost` for the same reason everything else in this suite does: the two
 * are different addresses, and the prober is handed an IP literal.
 */
export async function startTlsTestServer(options: TlsTestServerOptions = {}): Promise<TlsTestServer> {
  const { rsaModulusBits = 2048, maxVersion } = options;
  const pair = selfSignedPair(rsaModulusBits);

  const server = tls.createServer(
    {
      key: pair.key,
      cert: pair.cert,
      ...(maxVersion ? { maxVersion } : {}),
    },
    // The prober ends the connection as soon as the handshake completes, so
    // there is no application data to serve. Draining is still necessary:
    // without a reader the socket would sit half-open until the process exits.
    (socket) => socket.resume(),
  );

  // A handshake the prober abandons (or a client that never completes one)
  // must not take the test process down with an unhandled 'error'.
  server.on("tlsClientError", () => undefined);
  server.on("error", () => undefined);

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("TLS test server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          pair.cleanup();
          resolve();
        });
      }),
  };
}

/**
 * A loopback TCP port with nothing listening on it, for the `unreachable`
 * case. Obtained by binding a real socket and releasing it rather than picking
 * a number and hoping: a hard-coded "surely nothing is on 9" is exactly the
 * kind of assumption that makes a suite fail on someone else's machine.
 */
export async function closedLoopbackPort(): Promise<number> {
  const server = await startTlsTestServer();
  const { port } = server;
  await server.close();
  return port;
}
