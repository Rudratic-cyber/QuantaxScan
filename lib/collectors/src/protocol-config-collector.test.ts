import { describe, expect, it } from "vitest";
import {
  detectProtocolConfigFormat,
  parseProtocolConfig,
  resolveToken,
  normaliseToken,
} from "./protocol-config";
import {
  collectProtocolConfigObservations,
  protocolConfigsIn,
  protocolConfigLocation,
  PROTOCOL_CONFIG_CONFIDENCE,
  ProtocolConfigCollector,
} from "./protocol-config-collector";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";
import { LocationDetailSchema } from "./location-detail";
import type { CollectionTarget } from "./types";

const REPO = "project:7";

function target(files: Array<{ path: string; content: string }>): CollectionTarget {
  return { kind: "source", repo: REPO, files: files.map((f) => ({ ...f, language: "config" })) };
}

describe("format detection", () => {
  it("recognises the SSH and IPsec families by basename, including drop-in directories", () => {
    expect(detectProtocolConfigFormat("/etc/ssh/sshd_config", "")).toBe("sshd-config");
    expect(detectProtocolConfigFormat("/etc/ssh/ssh_config", "")).toBe("ssh-config");
    expect(detectProtocolConfigFormat("/etc/ssh/sshd_config.d/10-hardening.conf", "")).toBe("sshd-config");
    expect(detectProtocolConfigFormat("home/deploy/.ssh/authorized_keys", "")).toBe("authorized-keys");
    expect(detectProtocolConfigFormat("/etc/ipsec.conf", "")).toBe("ipsec-config");
    expect(detectProtocolConfigFormat("/etc/swanctl/swanctl.conf", "")).toBe("ipsec-config");
  });

  it("recognises the JOSE and SAML families by structure, since their filenames are not conventional", () => {
    expect(detectProtocolConfigFormat("keys.json", '{"keys":[{"kty":"RSA","n":"AQAB","e":"AQAB"}]}')).toBe("jwks");
    expect(
      detectProtocolConfigFormat("discovery.json", '{"issuer":"https://x","id_token_signing_alg_values_supported":["RS256"]}'),
    ).toBe("oidc-discovery");
    expect(detectProtocolConfigFormat("idp.xml", '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"/>')).toBe(
      "saml-metadata",
    );
  });

  it("recognises nothing in prose, arbitrary JSON or malformed XML — the 'examined nothing' input", () => {
    expect(detectProtocolConfigFormat("README.md", "not a config, just prose about ssh_config")).toBeUndefined();
    expect(detectProtocolConfigFormat("package.json", '{"name":"app","dependencies":{}}')).toBeUndefined();
    expect(detectProtocolConfigFormat("keys.json", "{ this is not json")).toBeUndefined();
  });
});

describe("token resolution", () => {
  it("decodes the parametric SSH families to an algorithm and the curve's stated bit size", () => {
    expect(resolveToken("ecdsa-sha2-nistp384")).toEqual({ algorithm: "ECDSA", keySize: 384 });
    expect(resolveToken("ecdh-sha2-nistp521")).toEqual({ algorithm: "ECDH", keySize: 521 });
    expect(resolveToken("ssh-ed25519")).toEqual({ algorithm: "EdDSA", keySize: 256 });
    expect(resolveToken("diffie-hellman-group14-sha256")).toEqual({ algorithm: "DH", keySize: 2048 });
    // SSH's group1 is Oakley Group 2 (1024 bits), not Group 1 (768).
    expect(resolveToken("diffie-hellman-group1-sha1")).toEqual({ algorithm: "DH", keySize: 1024 });
    expect(resolveToken("aes256-ctr")).toEqual({ algorithm: "AES", keySize: 256 });
  });

  it("treats vendor suffixes, certificate variants and the security-key prefix as the same algorithm", () => {
    expect(normaliseToken("ssh-ed25519-cert-v01@openssh.com")).toBe("ssh-ed25519");
    expect(normaliseToken("sk-ecdsa-sha2-nistp256@openssh.com")).toBe("ecdsa-sha2-nistp256");
    expect(resolveToken("aes128-gcm@openssh.com")).toEqual({ algorithm: "AES", keySize: 128 });
    expect(resolveToken("curve25519-sha256@libssh.org")).toEqual({ algorithm: "ECDH", keySize: 256 });
  });

  it("resolves the JOSE alg vocabulary, including ES512's P-521 curve", () => {
    expect(resolveToken("RS256")).toEqual({ algorithm: "RSA" });
    expect(resolveToken("PS512")).toEqual({ algorithm: "RSA" });
    expect(resolveToken("ES256")).toEqual({ algorithm: "ECDSA", keySize: 256 });
    expect(resolveToken("ES512")).toEqual({ algorithm: "ECDSA", keySize: 521 });
    expect(resolveToken("EdDSA")).toEqual({ algorithm: "EdDSA" });
  });

  /**
   * The highest-consequence assertion in this file. Modern OpenSSH offers
   * hybrid post-quantum key exchange by default; a substring match on `x25519`
   * would report it as quantum-vulnerable `ECDH/DH` — a false positive on the
   * exact axis this product measures. Whole-token matching makes it silent
   * instead, which is a gap, not a wrong answer.
   */
  it("does NOT resolve hybrid post-quantum key exchange as classical ECDH", () => {
    expect(resolveToken("sntrup761x25519-sha512@openssh.com")).toBeUndefined();
    expect(resolveToken("mlkem768x25519-sha256")).toBeUndefined();
    expect(resolveToken("sntrup761x25519-sha512")).toBeUndefined();
  });

  it("resolves nothing for tokens algorithms.json has no canonical name for, rather than inventing one", () => {
    for (const token of ["hmac-sha2-256", "HS256", "none", "chacha20-poly1305@openssh.com", "3des-cbc", "umac-128@openssh.com"]) {
      expect(resolveToken(token), token).toBeUndefined();
    }
  });
});

describe("sshd_config", () => {
  const SSHD = `
# Managed by config management
#Ciphers aes128-cbc,3des-cbc
Port 22
HostKeyAlgorithms ssh-ed25519,ssh-rsa,rsa-sha2-512
KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256,diffie-hellman-group14-sha256
Ciphers aes256-ctr,aes128-ctr
MACs hmac-sha2-256,hmac-sha1

Match Address 10.0.0.0/8
    PubkeyAcceptedAlgorithms ssh-dss
`;

  it("reads declared directives and ignores the commented-out defaults OpenSSH ships", () => {
    const declared = parseProtocolConfig("sshd-config", SSHD);
    // `#Ciphers aes128-cbc,3des-cbc` is documentation of the compiled-in
    // default, not a declaration — a stock sshd_config is almost entirely
    // these, and reading them would turn every untouched install into findings.
    expect(declared.some((d) => d.token === "aes128-cbc")).toBe(false);
    expect(declared.filter((d) => d.directive === "Ciphers").map((d) => d.token)).toEqual(["aes256-ctr", "aes128-ctr"]);
  });

  it("keeps a 128-bit and a 256-bit cipher from the same directive distinct", () => {
    const declared = parseProtocolConfig("sshd-config", SSHD);
    const ciphers = declared.filter((d) => d.directive === "Ciphers");
    expect(ciphers.map((d) => d.keySize)).toEqual([256, 128]);
    // ...and the fingerprint keeps them apart too, which is why `token` is in
    // the identity at all.
    const fingerprints = new Set(
      ciphers.map((d) =>
        computeFingerprint({
          surface: "config",
          repo: REPO,
          path: "/etc/ssh/sshd_config",
          directive: d.directive,
          algorithm: d.algorithm,
          token: d.token,
        }),
      ),
    );
    expect(fingerprints.size).toBe(2);
  });

  it("carries the enclosing Match condition rather than reporting it as a global declaration", () => {
    const declared = parseProtocolConfig("sshd-config", SSHD);
    const dss = declared.find((d) => d.token === "ssh-dss");
    expect(dss?.condition).toBe("Match Address 10.0.0.0/8");
    expect(declared.find((d) => d.token === "ssh-ed25519")?.condition).toBeUndefined();
  });

  it("does not report a removal list as a declaration", () => {
    // `Ciphers -aes128-cbc` is an administrator REMOVING a weak cipher from the
    // default set. Reporting it would invert the meaning of the hardening.
    const declared = parseProtocolConfig("sshd-config", "Ciphers -aes128-cbc,aes192-cbc\n");
    expect(declared).toEqual([]);
    // `+` and `^` append/prepend, and those tokens genuinely are declared.
    const appended = parseProtocolConfig("sshd-config", "Ciphers +aes256-cbc\n");
    expect(appended.map((d) => d.token)).toEqual(["aes256-cbc"]);
  });

  it("is examined-and-empty, not unreadable, when a valid config declares no crypto", () => {
    const format = detectProtocolConfigFormat("/etc/ssh/sshd_config", "Port 2222\nPermitRootLogin no\n");
    expect(format).toBe("sshd-config");
    expect(parseProtocolConfig(format!, "Port 2222\nPermitRootLogin no\n")).toEqual([]);
  });
});

describe("authorized_keys", () => {
  it("reads the key type past an options prefix containing quoted spaces", () => {
    const content = [
      "# deploy keys",
      'command="/usr/bin/rrsync -ro /data",no-pty ssh-rsa AAAAB3NzaC1yc2E deploy@host',
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 laptop",
    ].join("\n");
    const declared = parseProtocolConfig("authorized-keys", content);
    expect(declared.map((d) => d.token)).toEqual(["ssh-rsa", "ssh-ed25519"]);
    // A key that exists on the box, not an entry on a menu.
    expect(declared.every((d) => d.strength === "materialised")).toBe(true);
  });

  it("leaves an RSA key's size undetermined rather than guessing it from the blob", () => {
    const declared = parseProtocolConfig("authorized-keys", "ssh-rsa AAAAB3NzaC1yc2E user@host");
    expect(declared[0].keySize).toBeUndefined();
  });

  it("does not read a comment or options field as the key type", () => {
    // Only fields shaped like a key type are tested at all. Without that
    // filter a comment reading `sha1` resolves through the shared token table
    // and is reported as this key's algorithm.
    expect(parseProtocolConfig("authorized-keys", 'from="host" sha1 AAAA broken-line')).toEqual([]);
    expect(parseProtocolConfig("authorized-keys", "ssh-rsa AAAAB3NzaC1yc2E md5").map((d) => d.token)).toEqual(["ssh-rsa"]);
  });
});

describe("IPsec proposals", () => {
  it("splits each proposal into its transforms and reads the ones it knows", () => {
    const declared = parseProtocolConfig("ipsec-config", "conn site\n  ike=aes256-sha256-modp2048,aes128-sha1-modp1024!\n");
    expect(declared.map((d) => [d.token, d.algorithm, d.keySize])).toEqual([
      ["aes256", "AES", 256],
      ["modp2048", "DH", 2048],
      ["aes128", "AES", 128],
      ["sha1", "SHA-1", undefined],
      ["modp1024", "DH", 1024],
    ]);
    // sha256 has no canonical name in algorithms.json and contributes nothing.
    expect(declared.some((d) => d.token === "sha256")).toBe(false);
  });

  it("does not resolve a bare `dh` segment, which is an xmldsig fragment and not an IPsec transform", () => {
    // Splitting a proposal on `-` puts every short token in front of the table.
    // `dh` used to resolve there and produce a phantom ECDH/DH declaration with
    // no key size, sitting next to the real `modp2048` one on the same line.
    const declared = parseProtocolConfig("ipsec-config", "conn s\n  ike=aes256-dh-modp2048\n");
    expect(declared.map((d) => d.token)).toEqual(["aes256", "modp2048"]);
    // ...and it still resolves where it does mean something.
    expect(
      parseProtocolConfig(
        "saml-metadata",
        '<EntityDescriptor><EncryptionMethod Algorithm="http://www.w3.org/2009/xmlenc11#dh"/></EntityDescriptor>',
      ).map((d) => d.algorithm),
    ).toEqual(["DH"]);
  });
});

describe("JWKS and OIDC discovery", () => {
  it("reads an RSA JWK's real modulus size off the `n` parameter", () => {
    // 2048-bit modulus: 256 base64url-encoded bytes.
    const n = Buffer.alloc(256, 0xab).toString("base64url");
    const declared = parseProtocolConfig("jwks", JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", n, e: "AQAB" }] }));
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({ directive: "alg", algorithm: "RSA", keySize: 2048, strength: "materialised" });
  });

  it("falls back to kty/crv when a JWK states no alg, and emits one declaration per key either way", () => {
    const declared = parseProtocolConfig(
      "jwks",
      JSON.stringify({ keys: [{ kty: "EC", crv: "P-384" }, { kty: "OKP", crv: "Ed25519" }, { kty: "oct", k: "AAA" }] }),
    );
    expect(declared.map((d) => [d.algorithm, d.keySize])).toEqual([
      ["ECDSA", 384],
      ["EdDSA", 256],
    ]);
  });

  it("reads every *_alg_values_supported field by suffix, and prices them as permitted", () => {
    const declared = parseProtocolConfig(
      "oidc-discovery",
      JSON.stringify({
        issuer: "https://idp.example",
        id_token_signing_alg_values_supported: ["RS256", "ES256", "HS256", "none"],
        request_object_encryption_alg_values_supported: ["RSA-OAEP-256"],
      }),
    );
    expect(declared.map((d) => d.token)).toEqual(["RS256", "ES256", "RSA-OAEP-256"]);
    expect(declared.every((d) => d.strength === "permitted")).toBe(true);
  });
});

describe("SAML metadata", () => {
  const METADATA = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example">
  <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
    <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
    <ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>
  </ds:Signature>
  <md:KeyDescriptor use="encryption">
    <md:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"/>
  </md:KeyDescriptor>
</md:EntityDescriptor>`;

  it("reads signature, digest and encryption methods, splitting materialised from permitted", () => {
    const declared = parseProtocolConfig("saml-metadata", METADATA);
    expect(declared.map((d) => [d.directive, d.algorithm, d.strength])).toEqual([
      ["SignatureMethod", "RSA", "materialised"],
      ["DigestMethod", "SHA-1", "materialised"],
      // What the entity will accept, not what it used.
      ["EncryptionMethod", "RSA", "permitted"],
    ]);
  });
});

describe("observations", () => {
  const SSHD_PATH = "/etc/ssh/sshd_config";
  const collected = collectProtocolConfigObservations(
    target([{ path: SSHD_PATH, content: "HostKeyAlgorithms ssh-ed25519\nKexAlgorithms curve25519-sha256\n" }]),
  );

  it("locates every declaration at the FILE, so a removed directive falls inside the reobservation scope", () => {
    expect(new Set(collected.map((o) => o.location))).toEqual(new Set([protocolConfigLocation(REPO, SSHD_PATH)]));
    expect(protocolConfigLocation(REPO, SSHD_PATH)).toBe(`${REPO}:config:${SSHD_PATH}`);
  });

  it("records configuration_information at a confidence well below an observed handshake", () => {
    for (const observation of collected) {
      expect(observation.discoveryModality).toBe("configuration_information");
      expect(observation.confidence).toBe(PROTOCOL_CONFIG_CONFIDENCE.permitted);
      expect(observation.confidence).toBeLessThan(1.0);
    }
    expect(PROTOCOL_CONFIG_CONFIDENCE.permitted).toBeLessThan(PROTOCOL_CONFIG_CONFIDENCE.materialised);
    expect(PROTOCOL_CONFIG_CONFIDENCE.materialised).toBeLessThan(0.9);
  });

  it("emits a locationDetail the shared schema accepts and the fingerprint bridge routes to `config`", () => {
    for (const observation of collected) {
      expect(LocationDetailSchema.safeParse(observation.locationDetail).success).toBe(true);
      const input = fingerprintForObservation(observation, { repo: REPO });
      expect(input?.surface).toBe("config");
    }
  });

  it("gives the same token under two different directives two identities", () => {
    const observations = collectProtocolConfigObservations(
      target([{ path: SSHD_PATH, content: "HostKeyAlgorithms ssh-rsa\nPubkeyAcceptedAlgorithms ssh-rsa\n" }]),
    );
    const fingerprints = new Set(
      observations.map((o) => computeFingerprint(fingerprintForObservation(o, { repo: REPO })!)),
    );
    expect(fingerprints.size).toBe(2);
  });

  it("is stable across reformatting: moving the directive does not change the identity", () => {
    const before = collectProtocolConfigObservations(target([{ path: SSHD_PATH, content: "HostKeyAlgorithms ssh-rsa\n" }]));
    const after = collectProtocolConfigObservations(
      target([{ path: SSHD_PATH, content: "# a new banner comment\nPort 22\n\nHostKeyAlgorithms   ssh-rsa\n" }]),
    );
    expect(computeFingerprint(fingerprintForObservation(after[0], { repo: REPO })!)).toBe(
      computeFingerprint(fingerprintForObservation(before[0], { repo: REPO })!),
    );
  });
});

describe("protocolConfigsIn — the ingest path's examined-anything gate", () => {
  it("lists a recognised file that declares nothing, and omits a file it cannot read at all", () => {
    const recognised = protocolConfigsIn(
      target([
        { path: "/etc/ssh/sshd_config", content: "HostKeyAlgorithms ssh-ed25519\n" },
        { path: "/etc/ssh/sshd_config.d/20-ports.conf", content: "Port 2222\n" },
        { path: "README.md", content: "prose" },
      ]),
    );
    expect(recognised).toEqual([
      { path: "/etc/ssh/sshd_config", format: "sshd-config", declarationCount: 1 },
      { path: "/etc/ssh/sshd_config.d/20-ports.conf", format: "sshd-config", declarationCount: 0 },
    ]);
  });
});

describe("the Collector interface", () => {
  it("declares the config surface and streams the same observations", async () => {
    const collector = new ProtocolConfigCollector();
    expect(collector.surface).toBe("config");
    const streamed = [];
    for await (const observation of collector.collect(
      target([{ path: "/etc/ssh/sshd_config", content: "Ciphers aes256-ctr\n" }]),
      { organizationId: 1 },
    )) {
      streamed.push(observation);
    }
    expect(streamed).toHaveLength(1);
    expect(streamed[0].algorithm).toBe("AES");
  });
});
