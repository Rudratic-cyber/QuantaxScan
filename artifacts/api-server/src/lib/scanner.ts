import { logger } from "./logger";

export interface ScanFinding {
  fileName: string;
  lineNumber: number;
  severity: "critical" | "alert" | "safe";
  algorithm: string;
  codeSnippet: string;
  nistReplacement: string | null;
  nistStandard: string | null;
  effortHours: number;
  explanation: string;
}

export interface ScanResult {
  findings: ScanFinding[];
  totalLines: number;
  criticalCount: number;
  alertCount: number;
  cleanCount: number;
  riskScore: number;
  totalEffortHours: number;
  estimatedCost: number;
  executiveSummary: string;
}

const VULNERABILITY_PATTERNS: Array<{
  pattern: RegExp;
  algorithm: string;
  severity: "critical" | "alert";
  nistReplacement: string;
  nistStandard: string;
  baseEffort: number;
  explanation: string;
}> = [
  {
    pattern: /\b(RSA|Crypto\.PublicKey\.RSA|KeyPairGenerator\s*\(\s*["']RSA["']\)|generateKeyPair\s*\(\s*['"]rsa['"]|new\s+RSA\b)/i,
    algorithm: "RSA",
    severity: "critical",
    nistReplacement: "ML-KEM-768 (CRYSTALS-Kyber)",
    nistStandard: "FIPS 203",
    baseEffort: 4,
    explanation:
      "RSA is vulnerable to Shor's algorithm on quantum computers. NIST mandates migration to ML-KEM (CRYSTALS-Kyber) for key encapsulation or ML-DSA for signatures.",
  },
  {
    pattern: /\b(ECDSA|secp256k1|prime256v1|elliptic\.P256|EC\.sign|createSign\s*\(\s*['"]sha256WithRSAEncryption['"])/i,
    algorithm: "ECDSA",
    severity: "critical",
    nistReplacement: "ML-DSA (CRYSTALS-Dilithium)",
    nistStandard: "FIPS 204",
    baseEffort: 4,
    explanation:
      "ECDSA relies on elliptic curve discrete logarithm, which Shor's algorithm breaks. Replace with ML-DSA (CRYSTALS-Dilithium) per FIPS 204.",
  },
  {
    pattern: /\b(ECDH|createECDH|DH\b|DHParameterSpec|getDiffieHellman)/i,
    algorithm: "ECDH/DH",
    severity: "critical",
    nistReplacement: "ML-KEM-768 (CRYSTALS-Kyber)",
    nistStandard: "FIPS 203",
    baseEffort: 8,
    explanation:
      "Diffie-Hellman and ECDH key exchange are broken by quantum computers. ML-KEM (CRYSTALS-Kyber) is the NIST-approved replacement for key agreement.",
  },
  {
    pattern: /\b(DSA\b|KeyPairGenerator\s*\(\s*["']DSA["'])/i,
    algorithm: "DSA",
    severity: "critical",
    nistReplacement: "SLH-DSA (SPHINCS+)",
    nistStandard: "FIPS 205",
    baseEffort: 6,
    explanation:
      "DSA is vulnerable to quantum attacks. SLH-DSA (SPHINCS+) is the stateless hash-based signature scheme approved in FIPS 205.",
  },
  {
    pattern: /\b(md5|hashlib\.md5|createHash\s*\(\s*['"]md5['"]|MD5\b)/i,
    algorithm: "MD5",
    severity: "alert",
    nistReplacement: "SHA-256 or SHA-3",
    nistStandard: "NIST SP 800-107",
    baseEffort: 0.5,
    explanation:
      "MD5 is cryptographically broken. While not directly broken by quantum computers, it provides no meaningful security. Replace with SHA-256 or SHA-3.",
  },
  {
    pattern: /\b(sha1|hashlib\.sha1|SHA1\b|createHash\s*\(\s*['"]sha1['"]|getInstance\s*\(\s*["']SHA-1["'])/i,
    algorithm: "SHA-1",
    severity: "alert",
    nistReplacement: "SHA-256 or SHA-3",
    nistStandard: "NIST SP 800-107",
    baseEffort: 0.5,
    explanation:
      "SHA-1 is deprecated and insecure. Grover's algorithm reduces its security. Upgrade to SHA-256 or SHA-3-256.",
  },
  {
    pattern: /\b(AES[_-]ECB|AES\/ECB|getInstance\s*\(\s*["']AES\/ECB\/|Cipher\.ECB|mode\s*=\s*['"]ECB['"])/i,
    algorithm: "AES-ECB",
    severity: "alert",
    nistReplacement: "AES-GCM or AES-CBC",
    nistStandard: "NIST SP 800-38D",
    baseEffort: 1,
    explanation:
      "AES-ECB mode is structurally insecure — identical plaintext blocks produce identical ciphertext. Switch to AES-GCM for authenticated encryption or AES-CBC with proper IV.",
  },
];

const NIST_REPLACEMENTS: Record<string, { replacement: string; standard: string }> = {
  RSA: { replacement: "ML-KEM-768 (CRYSTALS-Kyber)", standard: "FIPS 203" },
  ECDSA: { replacement: "ML-DSA (CRYSTALS-Dilithium)", standard: "FIPS 204" },
  "ECDH/DH": { replacement: "ML-KEM-768 (CRYSTALS-Kyber)", standard: "FIPS 203" },
  DSA: { replacement: "SLH-DSA (SPHINCS+)", standard: "FIPS 205" },
  MD5: { replacement: "SHA-256 or SHA-3", standard: "NIST SP 800-107" },
  "SHA-1": { replacement: "SHA-256 or SHA-3", standard: "NIST SP 800-107" },
  "AES-ECB": { replacement: "AES-GCM or AES-CBC", standard: "NIST SP 800-38D" },
};

export function scanCode(code: string, fileName: string, language: string): ScanFinding[] {
  const lines = code.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const vuln of VULNERABILITY_PATTERNS) {
      if (vuln.pattern.test(line)) {
        findings.push({
          fileName,
          lineNumber: lineNum,
          severity: vuln.severity,
          algorithm: vuln.algorithm,
          codeSnippet: line.trim().substring(0, 200),
          nistReplacement: vuln.nistReplacement,
          nistStandard: vuln.nistStandard,
          effortHours: vuln.baseEffort,
          explanation: vuln.explanation,
        });
        break; // Only one finding per line
      }
    }
  }

  return findings;
}

export function computeScanResult(findings: ScanFinding[], totalLines: number): Omit<ScanResult, "executiveSummary" | "findings"> {
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const alertCount = findings.filter((f) => f.severity === "alert").length;
  const cleanCount = totalLines - criticalCount - alertCount;
  const totalEffortHours = findings.reduce((sum, f) => sum + f.effortHours, 0);
  const estimatedCost = Math.round(totalEffortHours * 500); // $500/hr security consultant rate

  // Risk score 0-100: higher = more vulnerable
  const riskScore = Math.min(
    100,
    Math.round(
      (criticalCount * 3 + alertCount) /
        Math.max(1, totalLines) *
        1000 +
        (criticalCount > 0 ? 40 : 0) +
        (alertCount > 0 ? 10 : 0)
    )
  );

  return {
    totalLines,
    criticalCount,
    alertCount,
    cleanCount: Math.max(0, cleanCount),
    riskScore: Math.min(100, riskScore),
    totalEffortHours,
    estimatedCost,
  };
}

export function generateExecutiveSummary(
  findings: ScanFinding[],
  totalLines: number,
  language: string
): string {
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const alertCount = findings.filter((f) => f.severity === "alert").length;
  
  const algoCounts: Record<string, number> = {};
  for (const f of findings) {
    algoCounts[f.algorithm] = (algoCounts[f.algorithm] || 0) + 1;
  }

  const topAlgo = Object.entries(algoCounts).sort((a, b) => b[1] - a[1])[0];

  if (criticalCount === 0 && alertCount === 0) {
    return `We scanned ${totalLines.toLocaleString()} lines of ${language} code and found no quantum-vulnerable cryptographic patterns. Your codebase appears quantum-safe based on detected cryptographic usage.`;
  }

  const parts = [`We scanned ${totalLines.toLocaleString()} lines of ${language} code.`];

  if (criticalCount > 0) {
    parts.push(
      `Found ${criticalCount} quantum-critical vulnerabilit${criticalCount === 1 ? "y" : "ies"} that will break on Q-Day.`
    );
  }

  if (alertCount > 0) {
    parts.push(`Found ${alertCount} weaker-crypto alert${alertCount === 1 ? "" : "s"} (not directly quantum-broken but non-PQC-safe).`);
  }

  if (topAlgo) {
    parts.push(
      `Your highest-risk pattern is ${topAlgo[0]} with ${topAlgo[1]} occurrence${topAlgo[1] === 1 ? "" : "s"}.`
    );
  }

  parts.push("Immediate migration to NIST PQC standards (FIPS 203/204/205) is recommended.");

  return parts.join(" ");
}
