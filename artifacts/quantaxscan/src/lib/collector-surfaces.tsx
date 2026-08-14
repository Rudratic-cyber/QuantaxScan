import { Boxes, FileCode, Network, Lock, KeyRound, Server, Database, FileText, Building2, Binary } from "lucide-react";
import {
  COLLECTOR_SURFACES,
  type CollectorSurfaceEntry,
  type CollectorSurfaceId,
} from "@workspace/collectors/surface-catalogue";

/**
 * Presentation for the ten collector surfaces, joined onto the catalogue in
 * `@workspace/collectors` by `id`.
 *
 * The catalogue owns *which* surfaces exist and which are live; this file owns
 * only the icon and the prose. The split keeps `@workspace/collectors`
 * dependency-free (it has to be able to ship as a standalone on-prem agent, so
 * no React and no marketing copy), and the `Record<CollectorSurfaceId, …>`
 * below makes the join exhaustive at compile time — adding an eleventh surface
 * to the catalogue fails to build here until it is given copy, rather than
 * silently vanishing from the page.
 *
 * Both consumers — the public coverage page and the per-project coverage meter
 * (D3) — read this list. Neither has its own copy.
 */

interface SurfacePresentation {
  icon: React.ReactNode;
  blurb: string;
}

const PRESENTATION: Record<CollectorSurfaceId, SurfacePresentation> = {
  source: {
    icon: <FileCode className="h-5 w-5" />,
    // Only the four asymmetric algorithms have a PQC successor. MD5, SHA-1 and AES-ECB are
    // classical hygiene, not quantum exposure — claiming a "NIST PQC replacement" for them is
    // the same category error the register records as G-10 (and G-09 for the ECB citation).
    blurb: "Regex + pattern detection across many languages. RSA, ECDSA, ECDH/DH and DSA are quantum-vulnerable and map to a NIST PQC replacement; MD5, SHA-1 and AES-ECB are classical hygiene findings with no PQC successor.",
  },
  dependency: {
    icon: <Boxes className="h-5 w-5" />,
    blurb: "Parse lockfiles and map to known crypto libraries and versions — the single biggest coverage jump, because most enterprise crypto lives here, not in first-party code.",
  },
  tls: {
    icon: <Network className="h-5 w-5" />,
    blurb: "Active handshake against your hosts, recording the key exchange that is actually negotiated — not what a config file claims.",
  },
  certificate: {
    icon: <Lock className="h-5 w-5" />,
    blurb: "Key type, size and expiry across your PKI. Expiry-versus-Q-Day is the chart that makes the timeline concrete.",
  },
  kms: {
    icon: <KeyRound className="h-5 w-5" />,
    blurb: "Vault, AWS KMS, Azure Key Vault and GCP KMS, via read-only, narrowly-scoped credentials you issue.",
  },
  config: {
    icon: <Server className="h-5 w-5" />,
    blurb: "SSH, IPsec, JWT alg, and SAML/OIDC signing — the crypto choices buried in configuration.",
  },
  "data-at-rest": {
    icon: <Database className="h-5 w-5" />,
    blurb: "Database TDE and backup/archive encryption — the true harvest-now-decrypt-later targets.",
  },
  ot: {
    icon: <FileText className="h-5 w-5" />,
    blurb: "A structured form, not a scanner, for the estate no tool can reach automatically. It has the longest lead time, so it enters the plan first.",
  },
  vendor: {
    icon: <Building2 className="h-5 w-5" />,
    blurb: "Questionnaire and contractual PQC clause tracking for the crypto you depend on but do not operate.",
  },
  binary: {
    icon: <Binary className="h-5 w-5" />,
    blurb: "Compiled artefacts with no source and no manifest. NIST SP 1800-38B places this inside core discovery; we have it deferred, and say so rather than omitting the surface.",
  },
};

export type CollectorSurface = CollectorSurfaceEntry & SurfacePresentation;

export const COLLECTOR_SURFACE_LIST: readonly CollectorSurface[] = COLLECTOR_SURFACES.map((entry) => ({
  ...entry,
  ...PRESENTATION[entry.id],
}));

export const LIVE_SURFACE_COUNT = COLLECTOR_SURFACE_LIST.filter((s) => s.status === "live").length;
export const TOTAL_SURFACE_COUNT = COLLECTOR_SURFACE_LIST.length;
