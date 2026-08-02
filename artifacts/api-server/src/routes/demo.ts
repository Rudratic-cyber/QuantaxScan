import { Router, type IRouter } from "express";
import { scanCode, computeScanResult, generateExecutiveSummary } from "../lib/scanner";
import { db, activityTable } from "@workspace/db";

const router: IRouter = Router();

interface DemoFile {
  path: string;
  content: string;
}

interface DemoRepo {
  slug: string;
  name: string;
  description: string;
  language: string;
  stars: number;
  repoUrl: string;
  files: DemoFile[];
}

const DEMO_REPOS: DemoRepo[] = [
  {
    slug: "paramiko-ssh",
    name: "paramiko/paramiko",
    description: "Python SSH library — RSA host keys, DH key exchange, DSA auth, SHA-1 session IDs",
    language: "Python",
    stars: 9100,
    repoUrl: "https://github.com/paramiko/paramiko",
    files: [
      {
        path: "paramiko/transport.py",
        content: `"""
SSH Transport Layer — Core Protocol Handler
Implements SSH-2.0 (RFC 4253) connection negotiation and packet framing.
"""
import os
import socket
import threading
import hashlib
import struct
from Crypto.PublicKey import RSA
from Crypto.Cipher import AES

class Transport:
    """Core SSH transport responsible for protocol negotiation."""

    _preferred_ciphers = ["aes128-ctr", "aes256-ctr", "aes128-cbc"]
    _preferred_macs = ["hmac-sha2-256", "hmac-sha1"]
    _preferred_keys = ["rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256"]

    def __init__(self, sock, server_mode=False):
        self.sock = sock
        self.server_mode = server_mode
        self._host_key = None
        self._session_id = None
        self._sequence_number_out = 0

    def generate_host_key(self, bits=2048):
        """Generate RSA host key for server identification."""
        key = RSA.generate(bits)
        self._host_key = key
        return key.publickey().export_key()

    def compute_session_id(self, client_random, server_random, dh_value):
        """Compute session ID using SHA-1 (RFC 4253 §7.2)."""
        h = hashlib.sha1()
        h.update(client_random)
        h.update(server_random)
        h.update(dh_value)
        self._session_id = h.digest()
        return self._session_id

    def get_host_key_fingerprint(self, key_bytes):
        """Return MD5 fingerprint of host key for legacy clients."""
        digest = hashlib.md5(key_bytes).hexdigest()
        return ":".join(digest[i:i+2] for i in range(0, len(digest), 2))

    def send_packet(self, data):
        """Encrypt and send an SSH packet."""
        length = len(data)
        header = struct.pack(">I", length)
        self.sock.sendall(header + data)
        self._sequence_number_out += 1

    def recv_packet(self):
        """Receive and decrypt an SSH packet."""
        header = self.sock.recv(4)
        length = struct.unpack(">I", header)[0]
        return self.sock.recv(length)

    def negotiate_algorithms(self, client_kexinit):
        """Match client and server algorithm preferences."""
        common = [c for c in self._preferred_ciphers if c in client_kexinit.get("ciphers", [])]
        return common[0] if common else "aes128-ctr"

    def close(self):
        """Gracefully terminate the transport."""
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        finally:
            self.sock.close()
`,
      },
      {
        path: "paramiko/kex_dh.py",
        content: `"""
Diffie-Hellman Key Exchange (RFC 4419)
Implements DH group exchange for SSH session key derivation.
"""
from Crypto.PublicKey import DH
import os

OAKLEY_G = 2

class KexDHGroup14:
    """DH group-14 key exchange (2048-bit)."""

    name = "diffie-hellman-group14-sha256"
    min_bits = 2048

    def __init__(self, transport):
        self.transport = transport
        self._params = None
        self._private_key = None

    def start_client(self):
        """Initiate DH key exchange as the client."""
        params = DH.generate_parameters(generator=OAKLEY_G, key_size=self.min_bits)
        self._params = params
        key = params.generate_key()
        self._private_key = key
        return int(key.publickey().y)

    def complete_exchange(self, server_public):
        """Complete key exchange with server's public value."""
        if self._private_key is None:
            raise RuntimeError("Key exchange not started")
        shared = pow(server_public, int(self._private_key.x), int(self._params.p))
        return shared.to_bytes(256, "big")

    def verify_host_key(self, key_blob, signature):
        """Verify the server's RSA host key signature."""
        from Crypto.Signature import pkcs1_15
        from Crypto.Hash import SHA256
        from Crypto.PublicKey import RSA
        pub_key = RSA.import_key(key_blob)
        h = SHA256.new(self.transport._session_id)
        try:
            pkcs1_15.new(pub_key).verify(h, signature)
            return True
        except ValueError:
            return False
`,
      },
      {
        path: "paramiko/auth_handler.py",
        content: `"""
SSH Authentication Handler (RFC 4252)
Manages publickey, password, and keyboard-interactive auth methods.
"""
from Crypto.PublicKey import RSA, DSA
from Crypto.Signature import pkcs1_15, DSS
from Crypto.Hash import SHA256
import hashlib


class AuthHandler:
    """Manages SSH authentication methods."""

    SUPPORTED_METHODS = ["publickey", "password", "keyboard-interactive"]

    def __init__(self, transport):
        self.transport = transport
        self._authenticated = False
        self._username = None

    def auth_password(self, username, password):
        """Authenticate with a password (sent over encrypted channel)."""
        self._username = username
        return self._send_auth_request("password", password.encode())

    def auth_publickey(self, username, key_file):
        """Authenticate using an RSA private key file."""
        self._username = username
        with open(key_file, "rb") as f:
            key_data = f.read()
        private_key = RSA.import_key(key_data)
        h = SHA256.new(self.transport._session_id)
        signature = pkcs1_15.new(private_key).sign(h)
        return self._send_auth_request("publickey", signature)

    def verify_dsa_hostkey(self, key_blob, sig_blob):
        """Verify a DSA host key signature (legacy server fallback)."""
        pub_key = DSA.import_key(key_blob)
        h = SHA256.new(self.transport._session_id)
        verifier = DSS.new(pub_key, "fips-186-3")
        try:
            verifier.verify(h, sig_blob)
            return True
        except ValueError:
            return False

    def _legacy_password_hash(self, password, salt=""):
        """Hash password for PAM compatibility check (legacy systems)."""
        return hashlib.md5((password + salt).encode()).hexdigest()

    def _send_auth_request(self, method, payload):
        """Package and send the authentication request packet."""
        packet = {
            "service": "ssh-connection",
            "method": method,
            "payload": payload.hex() if isinstance(payload, bytes) else payload,
        }
        return self.transport.send_packet(str(packet).encode())
`,
      },
      {
        path: "paramiko/config.py",
        content: `"""
SSH Client Configuration Parser
Handles ~/.ssh/config files per OpenSSH conventions.
"""
import os
import re
from pathlib import Path


class SSHConfig:
    """Parses SSH client configuration files."""

    KNOWN_OPTIONS = {
        "hostname", "port", "user", "identityfile",
        "stricthostkeychecking", "serveralivecountmax",
        "serveraliveinterval", "connecttimeout",
    }

    def __init__(self, path=None):
        self._data = {}
        if path is None:
            path = os.path.expanduser("~/.ssh/config")
        self.path = Path(path)

    def load(self):
        """Parse the configuration file."""
        if not self.path.exists():
            return
        with open(self.path) as f:
            lines = f.readlines()
        self._parse(lines)

    def _parse(self, lines):
        current_host = "*"
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
            elif " " in line:
                key, _, value = line.partition(" ")
            else:
                continue
            key = key.strip().lower()
            value = value.strip()
            if key == "host":
                current_host = value
                self._data.setdefault(current_host, {})
            elif key in self.KNOWN_OPTIONS:
                self._data.setdefault(current_host, {})[key] = value

    def lookup(self, hostname):
        """Return merged config options for a specific hostname."""
        result = dict(self._data.get("*", {}))
        for host_pattern, opts in self._data.items():
            if host_pattern == "*":
                continue
            pattern = host_pattern.replace("*", ".*").replace("?", ".")
            if re.fullmatch(pattern, hostname, re.IGNORECASE):
                result.update(opts)
        return result
`,
      },
    ],
  },
  {
    slug: "node-crypto-api",
    name: "node-vault/crypto-api",
    description: "Node.js secrets API — RSA encryption, ECDH key exchange, SHA-1 webhooks, MD5 legacy hashing",
    language: "JavaScript",
    stars: 3400,
    repoUrl: "https://github.com/nodejs/node",
    files: [
      {
        path: "src/encryption.js",
        content: `/**
 * Encryption Module — Secrets API Core
 * Handles RSA key pairs and ECDH key agreement for client sessions.
 */
const crypto = require('crypto');
const fs = require('fs');

class EncryptionService {
  constructor(config = {}) {
    this.keySize = config.keySize || 2048;
    this.privateKey = null;
    this.publicKey = null;
  }

  /**
   * Generate a new RSA key pair for encrypting secrets at rest.
   * NOTE: RSA-2048 chosen for compatibility — migrate to ML-KEM.
   */
  generateKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPair('rsa', {
      modulusLength: this.keySize,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    return { privateKey, publicKey };
  }

  /**
   * Encrypt a secret value with the service public key.
   */
  encryptSecret(plaintext) {
    const buffer = Buffer.from(plaintext, 'utf8');
    return crypto.publicEncrypt(this.publicKey, buffer).toString('base64');
  }

  /**
   * Decrypt a previously encrypted secret.
   */
  decryptSecret(ciphertext) {
    const buffer = Buffer.from(ciphertext, 'base64');
    return crypto.privateDecrypt(this.privateKey, buffer).toString('utf8');
  }

  /**
   * ECDH session key agreement for client-server handshake.
   */
  createClientHandshake() {
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.generateKeys();
    return {
      publicKey: ecdh.getPublicKey('base64'),
      _ecdh: ecdh,
    };
  }

  deriveSessionKey(handshake, serverPublicKey) {
    return handshake._ecdh.computeSecret(
      Buffer.from(serverPublicKey, 'base64')
    ).slice(0, 32);
  }
}

module.exports = { EncryptionService };
`,
      },
      {
        path: "src/auth.js",
        content: `/**
 * Authentication Middleware
 * Token signing, webhook verification, and API key hashing.
 */
const crypto = require('crypto');

class AuthService {
  constructor(signingKey) {
    this.signingKey = signingKey;
  }

  /**
   * Sign an API token using ECDSA over secp256k1.
   * Used for third-party integrations that require asymmetric tokens.
   */
  signToken(payload) {
    const sign = crypto.createSign('SHA256');
    sign.update(JSON.stringify(payload));
    sign.end();
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return sign.sign(this.signingKey, 'base64');
  }

  /**
   * Verify GitHub webhook payloads using SHA-1 HMAC.
   * GitHub sends X-Hub-Signature as sha1=<hex>.
   */
  verifyGithubWebhook(payload, signature) {
    const expected = crypto
      .createHash('sha1')
      .update(payload)
      .digest('hex');
    return \`sha1=\${expected}\` === signature;
  }

  /**
   * Verify Stripe webhook signatures (proper HMAC-SHA256).
   */
  verifyStripeWebhook(payload, signature, secret) {
    const hmac = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(hmac),
      Buffer.from(signature)
    );
  }
}

module.exports = { AuthService };
`,
      },
      {
        path: "src/hash.js",
        content: `/**
 * Hashing Utilities
 * Provides content addressing and legacy compatibility hashes.
 */
const crypto = require('crypto');

/**
 * Generate a content-addressable ID for a secret value.
 * Uses MD5 for fast deduplication — not for security.
 */
function contentId(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Compute a secure SHA-256 hash for integrity verification.
 */
function integrityHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Legacy transaction ID generation (MD5-based, kept for backward compat).
 * @deprecated Use integrityHash() for new transaction IDs.
 */
function legacyTxId(timestamp, userId) {
  const input = \`\${timestamp}:\${userId}\`;
  return crypto.createHash('md5').update(input).digest('hex');
}

module.exports = { contentId, integrityHash, legacyTxId };
`,
      },
      {
        path: "src/middleware.js",
        content: `/**
 * Express Middleware Stack
 * Rate limiting, request logging, and error handling.
 */
const express = require('express');

function rateLimiter(options = {}) {
  const windowMs = options.windowMs || 60_000;
  const max = options.max || 100;
  const store = new Map();

  return function (req, res, next) {
    const key = req.ip;
    const now = Date.now();
    const windowStart = now - windowMs;

    const timestamps = (store.get(key) || []).filter(t => t > windowStart);
    if (timestamps.length >= max) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    timestamps.push(now);
    store.set(key, timestamps);
    next();
  };
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    req.log[level]({ method: req.method, path: req.path, status: res.statusCode, ms });
  });
  next();
}

function errorHandler(err, req, res, next) {
  req.log.error({ err }, 'Unhandled error');
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
}

module.exports = { rateLimiter, requestLogger, errorHandler };
`,
      },
      {
        path: "src/server.js",
        content: `/**
 * API Server Entry Point
 */
const express = require('express');
const { rateLimiter, requestLogger, errorHandler } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);
app.use(rateLimiter({ windowMs: 60_000, max: 200 }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.use('/api/v1/secrets', require('./routes/secrets'));
app.use('/api/v1/auth', require('./routes/auth'));

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(\`Secrets API listening on :\${PORT}\`);
});
`,
      },
    ],
  },
  {
    slug: "go-tls-server",
    name: "go-microservice/tls-server",
    description: "Go microservice — RSA/ECDSA cert generation, SHA-1 fingerprints, ECDH key agreement",
    language: "Go",
    stars: 2100,
    repoUrl: "https://github.com/golang/crypto",
    files: [
      {
        path: "crypto/keys.go",
        content: `// Package crypto provides key generation utilities for the TLS server.
package crypto

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"math/big"
)

// RSAKeyBits is the modulus size for generated RSA keys.
const RSAKeyBits = 2048

// GenerateRSAKey generates a new RSA private key for TLS certificates.
// NOTE: RSA will be deprecated — migrate to ML-KEM (FIPS 203).
func GenerateRSAKey() (*rsa.PrivateKey, error) {
	return rsa.GenerateKey(rand.Reader, RSAKeyBits)
}

// GenerateECDSAKey generates an ECDSA key on the P-256 curve.
func GenerateECDSAKey() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// GenerateECDHKey creates an ECDH key pair for session key agreement.
func GenerateECDHKey() (*ecdh.PrivateKey, error) {
	curve := ecdh.P256()
	return curve.GenerateKey(rand.Reader)
}

// EncodeRSAKey encodes an RSA private key to PKCS#1 PEM.
func EncodeRSAKey(key *rsa.PrivateKey) []byte {
	return pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
}

// DHExchange performs a raw Diffie-Hellman exponentiation.
// g^x mod p — used for legacy protocol compatibility.
func DHExchange(g, x, p *big.Int) *big.Int {
	return new(big.Int).Exp(g, x, p)
}
`,
      },
      {
        path: "crypto/hash.go",
        content: `// Package crypto — fingerprint and digest utilities.
package crypto

import (
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// Fingerprint computes a colon-separated SHA-1 fingerprint of key material.
// Used for displaying host key fingerprints in legacy SSH-style output.
// NOTE: SHA-1 is deprecated — prefer SHA-256 fingerprints for new systems.
func Fingerprint(keyBytes []byte) string {
	h := sha1.New()
	h.Write(keyBytes)
	digest := h.Sum(nil)
	parts := make([]string, len(digest))
	for i, b := range digest {
		parts[i] = fmt.Sprintf("%02x", b)
	}
	return strings.Join(parts, ":")
}

// SecureFingerprint computes a SHA-256 fingerprint (OpenSSH default since 6.8).
func SecureFingerprint(keyBytes []byte) string {
	sum := sha256.Sum256(keyBytes)
	return "SHA256:" + hex.EncodeToString(sum[:])
}
`,
      },
      {
        path: "tls/config.go",
        content: `// Package tls provides TLS configuration for the microservice.
package tls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"time"
)

// SelfSignedConfig builds a TLS config with a self-signed certificate.
// Used in development; production should use certificates from a CA.
func SelfSignedConfig() (*tls.Config, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{Organization: []string{"QuantaXscan Demo"}},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		return nil, err
	}

	cert := tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  privateKey,
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// ECDSAConfig generates TLS config backed by an ECDSA P-256 key.
func ECDSAConfig() (*tls.Config, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
	}
	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{certDER}, PrivateKey: key}},
		MinVersion:   tls.VersionTLS12,
	}, nil
}
`,
      },
      {
        path: "api/handlers.go",
        content: `// Package api provides HTTP request handlers.
package api

import (
	"encoding/json"
	"net/http"
	"time"
)

type HealthResponse struct {
	Status    string    \`json:"status"\`
	Timestamp time.Time \`json:"timestamp"\`
	Version   string    \`json:"version"\`
}

func HealthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(HealthResponse{
		Status:    "ok",
		Timestamp: time.Now().UTC(),
		Version:   "1.0.0",
	})
}

func NotFoundHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, \`{"error":"not found"}\`, http.StatusNotFound)
}

func MethodNotAllowedHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, \`{"error":"method not allowed"}\`, http.StatusMethodNotAllowed)
}
`,
      },
      {
        path: "main.go",
        content: `package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/example/go-tls-server/api"
	tlsconfig "github.com/example/go-tls-server/tls"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8443"
	}

	tlsCfg, err := tlsconfig.SelfSignedConfig()
	if err != nil {
		log.Fatalf("Failed to build TLS config: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", api.HealthHandler)
	mux.HandleFunc("/", api.NotFoundHandler)

	server := &http.Server{
		Addr:      fmt.Sprintf(":%s", port),
		Handler:   mux,
		TLSConfig: tlsCfg,
	}

	log.Printf("TLS server starting on :%s", port)
	if err := server.ListenAndServeTLS("", ""); err != nil {
		log.Fatal(err)
	}
}
`,
      },
    ],
  },
];

router.get("/demo/repos", async (_req, res): Promise<void> => {
  res.json(
    DEMO_REPOS.map(({ slug, name, description, language, stars, repoUrl, files }) => {
      const allFindings = files.flatMap((f) => {
        const lang = language.toLowerCase();
        return scanCode(f.content, f.path, lang);
      });
      const totalLines = files.reduce((acc, f) => acc + f.content.split("\n").length, 0);
      const result = computeScanResult(allFindings, totalLines);
      return {
        slug,
        name,
        description,
        language,
        stars,
        repoUrl,
        fileCount: files.length,
        riskScore: result.riskScore,
        criticalCount: result.criticalCount,
        alertCount: result.alertCount,
      };
    })
  );
});

router.post("/demo/repos/:slug/scan", async (req, res): Promise<void> => {
  const rawSlug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const repo = DEMO_REPOS.find((r) => r.slug === rawSlug);

  if (!repo) {
    res.status(404).json({ error: "Demo repo not found" });
    return;
  }

  const lang = repo.language.toLowerCase();

  const fileResults = repo.files.map((f) => {
    const findings = scanCode(f.content, f.path, lang);
    const lines = f.content.split("\n").length;
    return {
      path: f.path,
      language: lang,
      content: f.content,
      lines,
      findings: findings.map((x, i) => ({ id: i + 1, scanId: -1, ...x })),
      criticalCount: findings.filter((x) => x.severity === "critical").length,
      alertCount: findings.filter((x) => x.severity === "alert").length,
    };
  });

  const allFindings = fileResults.flatMap((f) => f.findings);
  const totalLines = fileResults.reduce((acc, f) => acc + f.lines, 0);
  const result = computeScanResult(allFindings, totalLines);
  const summary = generateExecutiveSummary(allFindings, totalLines, repo.language);

  await db.insert(activityTable).values({
    description: `Demo scan run on ${repo.name} — found ${result.criticalCount} critical vulnerabilities`,
    severity: result.criticalCount > 0 ? "critical" : result.alertCount > 0 ? "alert" : "info",
  });

  res.json({
    id: -1,
    projectId: -1,
    mode: "scan-only",
    status: "completed",
    name: repo.name,
    repoUrl: repo.repoUrl,
    language: repo.language,
    riskScore: result.riskScore,
    totalLines,
    criticalCount: result.criticalCount,
    alertCount: result.alertCount,
    cleanCount: result.cleanCount,
    totalEffortHours: result.totalEffortHours,
    estimatedCost: result.estimatedCost,
    executiveSummary: summary,
    files: fileResults,
    findings: allFindings,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
});

export default router;
