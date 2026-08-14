import { useState, useMemo, useRef, useEffect, useCallback, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import JSZip from "jszip";
import {
  Shield, AlertTriangle, Zap, Play, Github, FileCode,
  ChevronRight, ChevronDown, X, Plus, Download,
  Files, MessageSquare, Settings, Send, RefreshCw,
  CheckCircle2, Clock, Bug, Terminal as TerminalIcon,
  ChevronUp, Maximize2, MoreHorizontal, Trash2,
  ExternalLink, Sparkles, Upload, FolderOpen, Atom,
} from "lucide-react";
import {
  useCreateProject, useCreateScan, useGetScan,
  getGetScanQueryKey, getGetScanFindingsQueryKey,
  useGetScanFindings, CreateScanBodyMode, Finding,
} from "@workspace/api-client-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api";

// ── File-type icon config (SVG doc-with-fold, matches folder palette) ──────────
const FILE_ICONS: Record<string, { bg: string; fold: string; fg: string; label: string }> = {
  java:      { bg: "#f97316", fold: "#c05409", fg: "#fff",    label: "J"   },
  js:        { bg: "#f0c400", fold: "#c09a00", fg: "#1a1200", label: "JS"  },
  ts:        { bg: "#3178c6", fold: "#25609e", fg: "#fff",    label: "TS"  },
  tsx:       { bg: "#06b6d4", fold: "#0594ac", fg: "#fff",    label: "TX"  },
  jsx:       { bg: "#f0c400", fold: "#c09a00", fg: "#1a1200", label: "JX"  },
  py:        { bg: "#3572a5", fold: "#2a5888", fg: "#ffd343", label: "PY"  },
  go:        { bg: "#00acd7", fold: "#0088ac", fg: "#fff",    label: "GO"  },
  rs:        { bg: "#ce422b", fold: "#a23521", fg: "#fff",    label: "RS"  },
  rb:        { bg: "#cc342d", fold: "#a22825", fg: "#fff",    label: "RB"  },
  php:       { bg: "#787cb5", fold: "#5f639b", fg: "#fff",    label: "PHP" },
  cs:        { bg: "#9b4f96", fold: "#7c3f78", fg: "#fff",    label: "C#"  },
  cpp:       { bg: "#2c59a8", fold: "#1f4585", fg: "#fff",    label: "C++" },
  c:         { bg: "#2c59a8", fold: "#1f4585", fg: "#fff",    label: "C"   },
  html:      { bg: "#e44d26", fold: "#b63d1e", fg: "#fff",    label: "HT"  },
  css:       { bg: "#1572b6", fold: "#105594", fg: "#fff",    label: "CSS" },
  json:      { bg: "#3e3e4a", fold: "#2a2a38", fg: "#ffd700", label: "{}"  },
  md:        { bg: "#083fa1", fold: "#063182", fg: "#fff",    label: "MD"  },
  sh:        { bg: "#1a4731", fold: "#123222", fg: "#4ade80", label: "$"   },
  yml:       { bg: "#cb171e", fold: "#a21219", fg: "#fff",    label: "YML" },
  yaml:      { bg: "#cb171e", fold: "#a21219", fg: "#fff",    label: "YML" },
  txt:       { bg: "#2a2a3a", fold: "#1a1a2a", fg: "#6b7280", label: "TXT" },
  gitignore: { bg: "#de4c36", fold: "#b33b27", fg: "#fff",    label: "GIT" },
};

const LANG_NAMES: Record<string, string> = {
  java: "Java",   js:  "JavaScript", ts:   "TypeScript", tsx:  "TSX",
  jsx:  "JSX",    py:  "Python",     go:   "Go",         rs:   "Rust",
  rb:   "Ruby",   php: "PHP",        cs:   "C#",         cpp:  "C++",
  c:    "C",      html:"HTML",       css:  "CSS",        json: "JSON",
  md:   "Markdown", sh: "Shell",     yml:  "YAML",       yaml: "YAML",
  txt:  "Text",
};

function getExt(path: string) { return path.split(".").pop()?.toLowerCase() ?? "txt"; }
function getLangKey(language: string, path?: string): string {
  if (path) { const e = getExt(path); if (FILE_ICONS[e]) return e; }
  const map: Record<string, string> = {
    python: "py", javascript: "js", typescript: "ts", java: "java",
    go: "go", rust: "rs", ruby: "rb", php: "php", csharp: "cs", cpp: "cpp", c: "c",
  };
  return map[language.toLowerCase()] ?? language.toLowerCase() ?? "txt";
}

function FileIcon({ ext }: { ext: string }) {
  const c  = FILE_ICONS[ext] ?? FILE_ICONS.txt;
  const n  = c.label.length;
  const fs = n >= 4 ? 2.7 : n === 3 ? 3.3 : n === 2 ? 4.2 : 5.5;
  return (
    <svg width="12" height="15" viewBox="0 0 12 15" fill="none" className="shrink-0">
      <path d="M0 1.5A1.5 1.5 0 011.5 0H8l3.5 3.5V13.5A1.5 1.5 0 0110 15H1.5A1.5 1.5 0 010 13.5V1.5z" fill={c.bg} />
      <path d="M8 0l3.5 3.5H8z" fill={c.fold} />
      <text x="5.5" y="10.5" textAnchor="middle" fontSize={fs} fill={c.fg}
        fontWeight="bold" fontFamily="'SF Mono','Fira Code',monospace">{c.label}</text>
    </svg>
  );
}

// ── Clean folder SVG icon (replaces emoji) ────────────────────────────────────
const FolderSvg = ({ open }: { open: boolean }) => (
  <svg width="14" height="12" viewBox="0 0 16 13" fill="none" className="shrink-0" aria-hidden>
    {open ? (
      <>
        <path d="M0 3a1 1 0 011-1h5l1.5 1.5H15a1 1 0 011 1v1H1L0 4.5V3z" fill="#c8976e" />
        <path d="M0 5.5h16L14.5 12H1.5L0 5.5z" fill="#dcb67a" />
      </>
    ) : (
      <path d="M0 3a1 1 0 011-1h5l1.5 1.5H15a1 1 0 011 1V11a1 1 0 01-1 1H1a1 1 0 01-1-1V3z" fill="#dcb67a" />
    )}
  </svg>
);

// ── Panel drag-resize factory (used outside component for purity) ─────────────
function makeResizeMD(
  setSize: (v: number) => void,
  currentSize: number,
  axis: "x" | "y",
  direction: 1 | -1,
  min: number,
  max: number,
) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    const start = axis === "x" ? e.clientX : e.clientY;
    const orig  = currentSize;
    const onMove = (ev: MouseEvent) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - start;
      setSize(Math.max(min, Math.min(max, orig + direction * d)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

// ── VS Code Light+ color palette (light editor theme) ──────────────────────────
const C = {
  blue:     "#0000ff",  // Java/C# keywords, type modifiers, declarations
  purple:   "#af00db",  // JS/TS/Python/Go control flow keywords
  teal:     "#267f99",  // class / type names (CamelCase)
  yellow:   "#795e26",  // function / method calls, decorators
  lblue:    "#001080",  // variables, parameters, properties, identifiers
  orange:   "#a31515",  // string literals
  green:    "#098658",  // numeric literals
  comment:  "#008000",  // comments
  lit:      "#0000ff",  // true / false / null / None / nil / undefined
  op:       "#0a0e1a",  // operators, punctuation, default text
  heading:  "#800000",  // markdown headings
  mdCode:   "#a31515",  // markdown inline code / fenced
  mdBold:   "#0a0e1a",  // markdown bold
  jsonKey:  "#0451a5",  // JSON object keys
} as const;

// ── Per-language keyword tables ────────────────────────────────────────────────
interface LangSpec { blue: Set<string>; purple: Set<string>; lit: Set<string> }

function mkSpec(b: string[], p: string[], l: string[]): LangSpec {
  return { blue: new Set(b), purple: new Set(p), lit: new Set(l) };
}

const LANG_SPEC: Record<string, LangSpec> = {
  java: mkSpec(
    ["abstract","boolean","break","byte","case","catch","char","class","const","continue","default",
     "do","double","else","enum","extends","final","finally","float","for","goto","if","implements",
     "import","instanceof","int","interface","long","native","new","package","private","protected",
     "public","return","short","static","strictfp","super","switch","synchronized","this","throw",
     "throws","transient","try","var","void","volatile","while","record","sealed","permits"],
    [], // Java — all keywords are blue in Dark+
    ["true","false","null"]
  ),
  py: mkSpec(
    [],
    ["and","as","assert","async","await","break","class","continue","def","del","elif","else",
     "except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not",
     "or","pass","raise","return","try","while","with","yield"],
    ["True","False","None","self","cls"]
  ),
  go: mkSpec(
    ["chan","const","func","interface","map","package","range","struct","type","var"],
    ["break","case","continue","default","defer","else","fallthrough","for","go","goto","if",
     "import","return","select","switch"],
    ["true","false","nil","iota"]
  ),
  js: mkSpec(
    [],
    ["async","await","break","case","catch","class","const","continue","debugger","default","delete",
     "do","else","export","extends","finally","for","from","function","if","import","in",
     "instanceof","let","new","of","return","static","super","switch","this","throw","try",
     "typeof","var","void","while","with","yield"],
    ["true","false","null","undefined","NaN","Infinity"]
  ),
  ts: mkSpec(
    ["abstract","as","declare","enum","implements","interface","is","keyof","namespace","never",
     "override","readonly","satisfies","type","unknown","using"],
    ["async","await","break","case","catch","class","const","continue","default","delete","do",
     "else","export","extends","finally","for","from","function","if","import","in","instanceof",
     "let","new","of","return","static","super","switch","this","throw","try","typeof","var",
     "void","while","yield"],
    ["true","false","null","undefined","NaN","Infinity","any","boolean","number","string","object"]
  ),
  rs: mkSpec(
    ["const","crate","dyn","enum","extern","fn","impl","mod","move","mut","pub","ref","Self",
     "static","struct","trait","type","union","unsafe","use","where"],
    ["as","async","await","break","continue","else","for","if","in","let","loop","match","return",
     "self","super","while"],
    ["true","false","Some","None","Ok","Err"]
  ),
  rb: mkSpec(
    ["class","def","end","module","require","require_relative","attr_accessor","attr_reader",
     "attr_writer","protected","private","public"],
    ["and","begin","break","case","do","else","elsif","ensure","for","if","in","next","not","or",
     "raise","rescue","retry","return","then","unless","until","when","while","yield"],
    ["true","false","nil","self","super"]
  ),
  cs: mkSpec(
    ["abstract","as","base","bool","byte","char","class","const","decimal","delegate","double",
     "enum","event","explicit","extern","fixed","float","implicit","interface","internal","long",
     "namespace","new","object","operator","out","override","params","private","protected","public",
     "readonly","record","ref","sbyte","sealed","short","sizeof","stackalloc","static","string",
     "struct","this","typeof","uint","ulong","unchecked","unsafe","ushort","using","virtual","void",
     "volatile"],
    ["break","case","catch","checked","continue","default","do","else","finally","for","foreach",
     "goto","if","in","is","lock","return","switch","throw","try","while"],
    ["true","false","null"]
  ),
};
LANG_SPEC.jsx = LANG_SPEC.js;
LANG_SPEC.tsx = LANG_SPEC.ts;
LANG_SPEC.cpp = LANG_SPEC.cs;
LANG_SPEC.c   = LANG_SPEC.cs;

// ── Specialised tokenisers ─────────────────────────────────────────────────────
type Token = { text: string; color: string };

function tokenizeJSON(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"')  { j++; break; }
        j++;
      }
      const str = line.slice(i, j);
      let k = j; while (k < line.length && line[k] === ' ') k++;
      tokens.push({ text: str, color: line[k] === ':' ? C.jsonKey : C.orange });
      i = j; continue;
    }
    if (/[0-9\-]/.test(ch)) {
      let j = i; while (j < line.length && /[0-9.eE+\-]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), color: C.green }); i = j; continue;
    }
    if (/[a-z]/.test(ch)) {
      let j = i; while (j < line.length && /[a-z]/.test(line[j])) j++;
      const word = line.slice(i, j);
      tokens.push({ text: word, color: word === 'null' ? C.lit : C.lit }); i = j; continue;
    }
    tokens.push({ text: ch, color: C.op }); i++;
  }
  return tokens;
}

function tokenizeMD(line: string): Token[] {
  const t = line.trim();
  if (/^#{1,6}\s/.test(t)) return [{ text: line, color: C.heading }];
  if (t.startsWith('```') || t.startsWith('~~~')) return [{ text: line, color: C.comment }];
  if (t.startsWith('>'))  return [{ text: line, color: C.comment }];
  if (t.startsWith('---') || t.startsWith('===') || t.startsWith('***')) return [{ text: line, color: C.teal }];
  if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
    const m = line.match(/^(\s*[-*+\d.]+\s)(.*)/);
    if (m) return [{ text: m[1], color: C.blue }, { text: m[2], color: C.op }];
  }
  // Inline: split on `code`, **bold**, *italic*, [link](url)
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map(p => {
    if (p.startsWith('`') && p.endsWith('`'))   return { text: p, color: C.mdCode };
    if (p.startsWith('**') && p.endsWith('**')) return { text: p, color: C.mdBold };
    if (p.startsWith('*') && p.endsWith('*'))   return { text: p, color: C.orange };
    if (p.startsWith('['))                       return { text: p, color: C.blue };
    return { text: p, color: C.op };
  });
}

function tokenizeCSS(line: string): Token[] {
  const t = line.trim();
  if (t.startsWith('/*') || t.startsWith('//')) return [{ text: line, color: C.comment }];
  if (/^[.#:[]/.test(t) || (t.endsWith('{') && !t.includes(':'))) return [{ text: line, color: C.yellow }];
  const colonIdx = line.indexOf(':');
  if (colonIdx > 0) {
    return [
      { text: line.slice(0, colonIdx), color: C.lblue },
      { text: ':', color: C.op },
      { text: line.slice(colonIdx + 1), color: C.orange },
    ];
  }
  return [{ text: line, color: C.op }];
}

// ── Main tokeniser ─────────────────────────────────────────────────────────────
function tokenizeLine(line: string, langKey: string): Token[] {
  if (langKey === "json") return tokenizeJSON(line);
  if (langKey === "md")   return tokenizeMD(line);
  if (langKey === "css")  return tokenizeCSS(line);

  const spec = LANG_SPEC[langKey];
  const tokens: Token[] = [];
  let i = 0;
  let afterDot = false;

  const push = (text: string, color: string) => { if (text) tokens.push({ text, color }); };

  while (i < line.length) {
    const ch = line[i];

    // ── Comments ──
    const isPy = langKey === "py" || langKey === "sh" || langKey === "yml" || langKey === "yaml";
    if (ch === '#' && isPy) { push(line.slice(i), C.comment); break; }
    if (ch === '/' && line[i + 1] === '/') { push(line.slice(i), C.comment); break; }
    if (ch === '/' && line[i + 1] === '*') { push(line.slice(i), C.comment); break; }
    // Continuation of block comment
    if (i === 0 && line.trimStart().startsWith('*')) { push(line, C.comment); break; }

    // ── Decorator / annotation ──
    if (ch === '@' && /[a-zA-Z]/.test(line[i + 1] ?? '')) {
      let j = i + 1;
      while (j < line.length && /[a-zA-Z0-9_.]/.test(line[j])) j++;
      push(line.slice(i, j), C.yellow);
      i = j; afterDot = false; continue;
    }

    // ── String literal ──
    if (ch === '"' || ch === "'" || ch === '`') {
      // Triple-quote check (Python)
      if ((ch === '"' || ch === "'") && line[i + 1] === ch && line[i + 2] === ch) {
        push(line.slice(i), C.orange); break;
      }
      const q = ch; let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === q)    { j++; break; }
        j++;
      }
      push(line.slice(i, j), C.orange);
      i = j; afterDot = false; continue;
    }

    // ── Number literal ──
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
      let j = i;
      if (ch === '0' && /[xXbBoO]/.test(line[i + 1] ?? '')) {
        j += 2; while (j < line.length && /[0-9a-fA-F_]/.test(line[j])) j++;
      } else {
        while (j < line.length && /[0-9._eELlFfDdBb]/.test(line[j])) j++;
      }
      push(line.slice(i, j), C.green);
      i = j; afterDot = false; continue;
    }

    // ── Dot — flag next word as property access ──
    if (ch === '.') {
      push('.', C.op); i++; afterDot = true; continue;
    }

    // ── Word (identifier / keyword) ──
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      // Look ahead for opening paren (skip whitespace)
      let k = j; while (k < line.length && line[k] === ' ') k++;
      const isCall = line[k] === '(';

      let color: string;
      if (afterDot) {
        color = isCall ? C.yellow : C.lblue;
      } else if (spec?.blue.has(word)) {
        color = C.blue;
      } else if (spec?.purple.has(word)) {
        color = C.purple;
      } else if (spec?.lit.has(word)) {
        color = C.lit;
      } else if (/^[A-Z][A-Z0-9_]*$/.test(word) && word.length > 1) {
        color = C.lblue; // ALL_CAPS constant
      } else if (/^[A-Z]/.test(word)) {
        color = C.teal;  // CamelCase = type/class
      } else if (isCall) {
        color = C.yellow; // function call
      } else {
        color = C.lblue;  // regular variable / identifier
      }
      push(word, color);
      i = j; afterDot = false; continue;
    }

    // ── Everything else (operators, punctuation, whitespace) ──
    push(ch, C.op);
    i++; afterDot = false;
  }

  return tokens;
}

function HighlightedLine({ text, langKey }: { text: string; langKey: string }) {
  const tokens = useMemo(() => tokenizeLine(text, langKey), [text, langKey]);
  if (!text.trim()) return <span style={{ color: C.op }}>&nbsp;</span>;
  return <>{tokens.map((t, i) => <span key={i} style={{ color: t.color }}>{t.text}</span>)}</>;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface Tab {
  id: string; label: string; ext: string; langKey: string;
  content: string; dirty?: boolean; path?: string;
  /** True for the shipped demo-project files. Dropped as soon as the user supplies their own. */
  sample?: boolean;
}
interface ChatMsg { id: string; role: "user" | "assistant"; content: string; }
interface ChatSession { id: string; title: string; messages: ChatMsg[]; createdAt: string; }

interface GithubFinding {
  lineNumber: number; severity: "critical" | "alert" | "safe";
  algorithm: string; codeSnippet: string;
  nistReplacement: string | null; nistStandard: string | null;
  explanation: string; effortHours: number; fileName: string;
}
interface GithubFileResult {
  path: string; language: string; lines: number;
  criticalCount: number; alertCount: number;
  content?: string; findings?: GithubFinding[];
}
interface GithubScanResult {
  repoUrl: string; owner: string; repo: string; totalFiles: number;
  findings: GithubFinding[]; criticalCount: number; alertCount: number;
  cleanCount: number; riskScore: number; totalLines: number;
  totalEffortHours?: number; executiveSummary: string;
  fileResults: GithubFileResult[];
}

// ── Two-phase GitHub fetch types ──────────────────────────────────────────────
interface RepoTreeNode { path: string; type: "blob" | "tree"; size?: number; }
interface FetchedRepoFile { path: string; language: string; content: string; lines: number; }
interface FetchedRepoData {
  owner: string; repo: string; repoUrl: string;
  totalNodes: number; truncated: boolean;
  fullTree: RepoTreeNode[];
  fetchedFiles: FetchedRepoFile[];
}
type GitHubPhase = "idle" | "fetching" | "fetched" | "scanning" | "scanned" | "error";

const SCANNABLE_EXTS_SET = new Set([
  ".py",".js",".ts",".go",".java",".cs",".cpp",".c",
  ".rb",".php",".rs",".kt",".swift",".scala",".sh",".tsx",".jsx",
]);

interface FullTreeNode {
  name: string; path: string; type: "file" | "folder";
  children?: FullTreeNode[];
  size?: number; scannable: boolean;
  content?: string; language?: string; lines?: number;
  criticalCount?: number; alertCount?: number;
  findings?: GithubFinding[];
}

// ── Sample file content ───────────────────────────────────────────────────────
const JAVA_MAIN = `import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import javax.crypto.KeyAgreement;

public class SecurityManager {
    public void initializeCrypto() throws Exception {
        // High Risk: RSA is vulnerable to Shor's algorithm
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
        kpg.initialize(2048);

        // Medium Risk: ECDSA
        KeyPairGenerator ecKpg = KeyPairGenerator.getInstance("EC");
        ecKpg.initialize(256);

        // Diffie-Hellman
        KeyAgreement dh = KeyAgreement.getInstance("DH");
    }

    public byte[] hashPassword(String password) throws Exception {
        // High Risk: MD5 is broken and vulnerable to collisions
        MessageDigest md = MessageDigest.getInstance("MD5");
        return md.digest(password.getBytes());
    }
}`;

const JAVA_CRYPTO = `import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.security.KeyPairGenerator;

public class CryptoManager {
    // CRITICAL: DES is broken — 56-bit key, vulnerable to brute force
    private static final String ALGORITHM = "DES";

    public static byte[] encrypt(byte[] data, byte[] key) throws Exception {
        SecretKeySpec keySpec = new SecretKeySpec(key, "DES");
        Cipher cipher = Cipher.getInstance("DES/ECB/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, keySpec);
        return cipher.doFinal(data);
    }

    // CRITICAL: RSA-1024 is quantum-vulnerable and classically weak
    public static void generateKey() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
        kpg.initialize(1024);
        kpg.generateKeyPair();
    }
}`;

const JAVA_HASH = `import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public class HashUtils {
    // CRITICAL: MD5 is cryptographically broken
    public static String md5(String input) throws NoSuchAlgorithmException {
        MessageDigest md = MessageDigest.getInstance("MD5");
        byte[] hash = md.digest(input.getBytes());
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    // ALERT: SHA-1 has known collision attacks (SHAttered)
    public static byte[] sha1(String input) throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("SHA-1").digest(input.getBytes());
    }

    // SAFE: SHA-256 provides 128-bit quantum security via Grover
    public static byte[] sha256(String input) throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("SHA-256").digest(input.getBytes());
    }
}`;

const PY_MAIN = `import hashlib
import rsa
from Crypto.Cipher import DES

# CRITICAL: RSA is vulnerable to Shor's algorithm on quantum computers
def generate_rsa_keypair():
    (pubkey, privkey) = rsa.newkeys(2048)
    return pubkey, privkey

# CRITICAL: MD5 is broken — use SHA-256 or SHA-3
def hash_password(password: str) -> str:
    return hashlib.md5(password.encode()).hexdigest()

# ALERT: SHA-1 has known collision attacks
def legacy_hash(data: bytes) -> bytes:
    return hashlib.sha1(data).digest()

# SAFE: Use SHA-256 for integrity checks
def safe_hash(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()`;

const PY_CRYPTO = `from Crypto.Cipher import DES, AES
from Crypto.PublicKey import RSA, ECC
import os

# CRITICAL: DES is completely broken — 56-bit key
SECRET_KEY = b"8bytekey"

def des_encrypt(data: bytes) -> bytes:
    cipher = DES.new(SECRET_KEY, DES.MODE_ECB)
    return cipher.encrypt(data)

# CRITICAL: ECDH is vulnerable to Shor's algorithm
def generate_ecdh_keypair():
    key = ECC.generate(curve='P-256')
    return key

# ALERT: RSA-1024 is classically and quantum weak
def rsa_1024():
    return RSA.generate(1024)`;

const GO_MAIN = `package main

import (
        "crypto/md5"
        "crypto/rsa"
        "crypto/rand"
        "crypto/elliptic"
        "fmt"
)

// CRITICAL: RSA is vulnerable to Shor's algorithm
func generateRSAKey() (*rsa.PrivateKey, error) {
        return rsa.GenerateKey(rand.Reader, 2048)
}

// CRITICAL: MD5 is cryptographically broken
func hashMD5(data string) string {
        h := md5.New()
        h.Write([]byte(data))
        return fmt.Sprintf("%x", h.Sum(nil))
}

// ALERT: ECDH on P-256 is quantum-vulnerable
func generateECDHKey() ([]byte, []byte, error) {
        curve := elliptic.P256()
        priv, x, y, err := elliptic.GenerateKey(curve, rand.Reader)
        return priv, append(x.Bytes(), y.Bytes()...), err
}`;

const GITIGNORE = `# Build output
*.class
*.jar
*.war
target/
build/
dist/

# Maven / Gradle
.mvn/
.gradle/
pom.xml.tag

# Python
__pycache__/
*.pyc
*.pyo
.venv/
venv/

# Go
*.test
vendor/

# IDE
.idea/
*.iml
.vscode/
.eclipse/
.settings/

# OS
.DS_Store
Thumbs.db
*.swp`;

const README_MD = `# QuantaXscan Security Audit

Post-quantum cryptography vulnerability scanner.

## Findings

This project contains **quantum-vulnerable** cryptographic implementations:

| Algorithm | Risk | Replacement |
|-----------|------|-------------|
| RSA-2048  | CRITICAL | ML-KEM-768 (NIST FIPS 203) |
| MD5       | CRITICAL | SHA-3-256 |
| DES       | CRITICAL | AES-256-GCM |
| ECDSA P-256 | CRITICAL | ML-DSA-65 (NIST FIPS 204) |
| SHA-1     | ALERT | SHA-256 |

## Migration

See [NIST PQC Project](https://csrc.nist.gov/pqcrypto) for details.`;

const PKG_JSON = `{
  "name": "security-manager",
  "version": "1.0.0",
  "description": "Cryptographic security utilities — PQC audit",
  "scripts": {
    "scan": "quantaxscan scan ./src",
    "build": "javac -d build src/**/*.java",
    "test": "junit5"
  },
  "devDependencies": {
    "quantaxscan": "^2.0.0"
  },
  "keywords": ["cryptography", "security", "post-quantum"],
  "license": "MIT"
}`;

// Why a GitHub action failed, in the user's terms. `long` is for the left rail and toasts,
// `short` for the one-line status in the centre pane. Deliberately does not tell the user to
// supply an API key — they have no way to do so from the browser, so that would misdirect too.
const GITHUB_AUTH_ERROR = {
  long: "Not authorised — the scanner API rejected this request. The URL is fine; repository fetching is not available in this build.",
  short: "Not authorised — the scanner API rejected this request.",
};
const GITHUB_RATE_LIMIT_ERROR = {
  long: "GitHub's unauthenticated rate limit was reached. The URL is fine — try again after the quota resets, or upload a .zip of the repo instead.",
  short: "GitHub rate limit reached — try again after the reset.",
};
const GITHUB_BAD_URL_ERROR = {
  long: "Repository not found — check the URL and try again.",
  short: "Error — check URL and try again.",
};

// Sample tree per language
type SampleFile = { name: string; content: string };
const LANG_SAMPLES: Record<string, SampleFile[]> = {
  java: [
    { name: "SecurityManager.java", content: JAVA_MAIN },
    { name: "CryptoManager.java",   content: JAVA_CRYPTO },
    { name: "HashUtils.java",        content: JAVA_HASH },
  ],
  py: [
    { name: "main.py",        content: PY_MAIN },
    { name: "crypto_utils.py", content: PY_CRYPTO },
  ],
  go: [{ name: "main.go", content: GO_MAIN }],
};

// ── File tree (GitHub mode) ───────────────────────────────────────────────────
interface TreeNode {
  name: string; path: string; type: "file" | "folder";
  children?: TreeNode[]; file?: GithubFileResult;
}
function buildFileTree(files: GithubFileResult[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let cur = root;
    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx];
      if (idx === parts.length - 1) {
        cur.push({ name: part, path: file.path, type: "file", file });
      } else {
        let folder = cur.find(n => n.name === part && n.type === "folder");
        if (!folder) { folder = { name: part, path: parts.slice(0, idx + 1).join("/"), type: "folder", children: [] }; cur.push(folder); }
        cur = folder.children!;
      }
    }
  }
  return root;
}

// ── Full repo tree (two-phase: all files including non-scannable) ─────────────
function buildFullTree(
  allNodes: RepoTreeNode[],
  fetchedFiles: FetchedRepoFile[],
  scannedFiles?: GithubFileResult[],
): FullTreeNode[] {
  const fetchedMap = new Map(fetchedFiles.map(f => [f.path, f]));
  const scannedMap = new Map(scannedFiles?.map(f => [f.path, f]) ?? []);
  const blobs = allNodes.filter(n => n.type === "blob");
  const root: FullTreeNode[] = [];
  for (const blob of blobs) {
    const parts = blob.path.split("/");
    let cur = root;
    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx];
      const partPath = parts.slice(0, idx + 1).join("/");
      if (idx === parts.length - 1) {
        const ext = "." + (part.split(".").pop()?.toLowerCase() ?? "");
        const scannable = SCANNABLE_EXTS_SET.has(ext);
        const fetched = fetchedMap.get(blob.path);
        const scanned = scannedMap.get(blob.path);
        cur.push({
          name: part, path: blob.path, type: "file",
          size: blob.size, scannable,
          content: fetched?.content, language: fetched?.language, lines: fetched?.lines,
          criticalCount: scanned?.criticalCount, alertCount: scanned?.alertCount,
          findings: scanned?.findings,
        });
      } else {
        let folder = cur.find(n => n.name === part && n.type === "folder");
        if (!folder) { folder = { name: part, path: partPath, type: "folder", children: [], scannable: false }; cur.push(folder); }
        cur = folder.children!;
      }
    }
  }
  return root;
}

function FullTreeItem({ node, depth, selectedPath, onSelect, collapsed, onToggle, phase }: {
  node: FullTreeNode; depth: number; selectedPath: string;
  onSelect: (n: FullTreeNode) => void;
  collapsed: Set<string>; onToggle: (p: string) => void;
  phase: GitHubPhase;
}) {
  const isFolder = node.type === "folder";
  const isOpen   = !collapsed.has(node.path);
  const isActive = node.path === selectedPath;
  const ext      = isFolder ? "" : getExt(node.name);
  const hasCrit  = (node.criticalCount ?? 0) > 0;
  const hasAlert = (node.alertCount ?? 0) > 0;
  const notFetched = !isFolder && !node.scannable;
  return (
    <>
      <div
        onClick={() => isFolder ? onToggle(node.path) : onSelect(node)}
        className={cn(
          "flex items-center gap-1.5 py-[3px] pr-2 cursor-pointer text-[12px] select-none rounded-sm",
          isActive ? "bg-[#eef0fe] text-[#0a0e1a]" : notFetched ? "text-[#9aa3b2] hover:text-[#6b7280] hover:bg-[#f7f8fa]" : "text-[#475569] hover:text-[#0a0e1a] hover:bg-[#f1f3f7]",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {isFolder
          ? <>{isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-[#9aa3b2]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[#9aa3b2]" />}<FolderSvg open={isOpen} /></>
          : <><span className="w-3 shrink-0" /><FileIcon ext={ext} /></>}
        <span className={cn("truncate flex-1 font-mono", notFetched && "opacity-40")}>{node.name}</span>
        <div className="flex gap-0.5 shrink-0 ml-auto items-center">
          {phase === "scanned" && hasCrit  && <div className="h-1.5 w-1.5 rounded-full bg-red-500" />}
          {phase === "scanned" && hasAlert && <div className="h-1.5 w-1.5 rounded-full bg-yellow-500" />}
          {phase === "fetched" && node.scannable && node.content && (
            <div className="h-1.5 w-1.5 rounded-full bg-[#4f46e5]/40" />
          )}
        </div>
      </div>
      {isFolder && isOpen && node.children?.map(child => (
        <FullTreeItem key={child.path} node={child} depth={depth + 1}
          selectedPath={selectedPath} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} phase={phase} />
      ))}
    </>
  );
}

function FileTreeItem({ node, depth, selectedPath, onSelect, collapsed, onToggle }: {
  node: TreeNode; depth: number; selectedPath: string;
  onSelect: (n: TreeNode) => void;
  collapsed: Set<string>; onToggle: (p: string) => void;
}) {
  const isFolder = node.type === "folder";
  const isOpen   = !collapsed.has(node.path);
  const isActive = node.path === selectedPath;
  const ext      = isFolder ? "" : getExt(node.name);
  const hasCrit  = node.file ? node.file.criticalCount > 0 : false;
  const hasAlert = node.file ? node.file.alertCount > 0 : false;
  return (
    <>
      <div
        onClick={() => isFolder ? onToggle(node.path) : onSelect(node)}
        className={cn(
          "flex items-center gap-1.5 py-[3px] pr-2 cursor-pointer text-[12px] select-none rounded-sm",
          isActive ? "bg-[#eef0fe] text-[#0a0e1a]" : "text-[#475569] hover:text-[#0a0e1a] hover:bg-[#f1f3f7]",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {isFolder
          ? <>{isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-[#9aa3b2]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[#9aa3b2]" />}<FolderSvg open={isOpen} /></>
          : <><span className="w-3 shrink-0" /><FileIcon ext={ext} /></>}
        <span className="truncate flex-1 font-mono">{node.name}</span>
        {(hasCrit || hasAlert) && (
          <div className="flex gap-0.5 shrink-0 ml-auto">
            {hasCrit  && <div className="h-1.5 w-1.5 rounded-full bg-red-500" />}
            {hasAlert && <div className="h-1.5 w-1.5 rounded-full bg-yellow-500" />}
          </div>
        )}
      </div>
      {isFolder && isOpen && node.children?.map(child => (
        <FileTreeItem key={child.path} node={child} depth={depth + 1}
          selectedPath={selectedPath} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} />
      ))}
    </>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
function TabBar({ tabs, activeId, onSelect, onClose, onNew }: {
  tabs: Tab[]; activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex items-end h-9 bg-[#f7f8fa] border-b border-[#e5e7eb] overflow-x-auto shrink-0">
      {tabs.map(tab => (
        <button key={tab.id} onClick={() => onSelect(tab.id)}
          className={cn(
            "group flex items-center gap-1.5 h-9 px-3 text-[12px] font-mono border-r border-[#e5e7eb] shrink-0 transition-colors",
            tab.id === activeId
              ? "bg-[#ffffff] text-[#4f46e5] border-t-2 border-t-[#4f46e5]"
              : "bg-[#f1f3f7] text-[#6b7280] hover:text-[#0a0e1a]",
          )}
        >
          <FileIcon ext={tab.ext} />
          <span>{tab.label}</span>
          {tab.dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400 ml-0.5" />}
          {tabs.length > 1 && (
            <span onClick={e => { e.stopPropagation(); onClose(tab.id); }}
              className="ml-1 opacity-0 group-hover:opacity-100 hover:text-[#0a0e1a] transition-opacity">
              <X className="h-3 w-3" />
            </span>
          )}
        </button>
      ))}
      <button onClick={onNew} className="h-9 px-2.5 text-[#9aa3b2] hover:text-[#334155] hover:bg-[#f1f3f7] transition-colors shrink-0">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Code editor ───────────────────────────────────────────────────────────────
function CodeEditorView({
  content, langKey, editable, findings, currentScanLine, scanState, onChange, onDrop,
}: {
  content: string; langKey: string; editable: boolean;
  findings: Finding[]; currentScanLine: number;
  scanState: "idle" | "scanning" | "complete";
  onChange?: (v: string) => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  const lines = content.split("\n");
  const findingMap = useMemo(() => {
    const m = new Map<number, Finding>();
    for (const f of findings) m.set(f.lineNumber, f);
    return m;
  }, [findings]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; };

  return (
    <div
      className="flex-1 overflow-hidden flex flex-col bg-[#ffffff]"
      style={{ fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" }}
      onDrop={onDrop}
      onDragOver={handleDragOver}
    >
      {editable ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Line numbers — stay in sync via shared scroll container */}
          <div className="w-12 shrink-0 bg-[#ffffff] border-r border-[#eceef2] overflow-hidden select-none pt-2" aria-hidden>
            {lines.map((_, i) => (
              <div key={i} className="text-right pr-3 text-[12px] text-[#9aa3b2] leading-[21px]">{i + 1}</div>
            ))}
          </div>
          {/* CSS-grid overlay: highlighted backdrop + transparent textarea share the same cell */}
          <div className="flex-1 overflow-auto">
            <div style={{ display: "grid" }} className="min-h-full">
              {/* Highlighted backdrop — determines height, pointer-events off */}
              <div
                aria-hidden
                className="text-[13px] leading-[21px] font-mono whitespace-pre pointer-events-none select-none"
                style={{ gridArea: "1/1", fontFamily: "inherit", padding: "8px 16px 48px 16px" }}
              >
                {lines.map((lineText, i) => (
                  <div key={i}><HighlightedLine text={lineText} langKey={langKey} /></div>
                ))}
              </div>
              {/* Transparent textarea sits on top — caret and selection visible, text invisible */}
              <textarea
                value={content}
                onChange={e => onChange?.(e.target.value)}
                onDrop={onDrop}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
                spellCheck={false}
                className="text-[13px] leading-[21px] font-mono resize-none focus:outline-none"
                style={{
                  gridArea: "1/1",
                  fontFamily: "inherit",
                  padding: "8px 16px 48px 16px",
                  color: "transparent",
                  caretColor: "#0a0e1a",
                  background: "transparent",
                }}
              />
            </div>
          </div>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex min-w-0 pt-2 pb-12">
            <div className="w-12 shrink-0 select-none border-r border-[#eceef2]">
              {lines.map((_, i) => {
                const f = findingMap.get(i + 1);
                return (
                  <div key={i} className={cn("text-right pr-3 text-[12px] leading-[21px]",
                    f?.severity === "critical" ? "text-red-500/80" :
                    f?.severity === "alert" ? "text-amber-600/80" : "text-[#9aa3b2]"
                  )}>{i + 1}</div>
                );
              })}
            </div>
            <div className="flex-1 overflow-x-auto">
              {lines.map((lineText, i) => {
                const ln = i + 1;
                const f = findingMap.get(ln);
                const isScanning = scanState === "scanning" && currentScanLine === i;
                return (
                  <div key={i} title={f ? `${f.algorithm}: ${f.explanation}` : undefined}
                    className={cn(
                      "flex items-start leading-[21px] text-[13px] border-l-2",
                      isScanning && "bg-[#4f46e5]/8 border-[#4f46e5]",
                      f?.severity === "critical" && !isScanning && "bg-red-500/8 border-red-500",
                      f?.severity === "alert"    && !isScanning && "bg-yellow-500/8 border-yellow-500",
                      !f && !isScanning && "border-transparent hover:bg-[#f7f8fa]",
                    )}
                  >
                    <div className="w-5 shrink-0 flex items-center justify-center mt-[2px]">
                      {f?.severity === "critical" && <AlertTriangle className="h-2.5 w-2.5 text-red-500" />}
                      {f?.severity === "alert"    && <Zap className="h-2.5 w-2.5 text-amber-600" />}
                    </div>
                    <div className="flex-1 pl-1 pr-6 whitespace-pre overflow-hidden">
                      <HighlightedLine text={lineText} langKey={langKey} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

// ── NIST reference links per vulnerable algorithm ─────────────────────────────
const VULN_REFS: Record<string, { label: string; url: string }> = {
  RSA:      { label: "NIST FIPS 203 — ML-KEM",  url: "https://csrc.nist.gov/pubs/fips/203/final" },
  ECDSA:    { label: "NIST FIPS 204 — ML-DSA",  url: "https://csrc.nist.gov/pubs/fips/204/final" },
  ECDH:     { label: "NIST FIPS 203 — ML-KEM",  url: "https://csrc.nist.gov/pubs/fips/203/final" },
  DH:       { label: "NIST PQC Project",         url: "https://csrc.nist.gov/projects/post-quantum-cryptography" },
  DSA:      { label: "NIST FIPS 204 — ML-DSA",  url: "https://csrc.nist.gov/pubs/fips/204/final" },
  MD5:      { label: "NIST Hash Policy",         url: "https://csrc.nist.gov/projects/hash-functions" },
  "SHA-1":  { label: "NIST FIPS 202 — SHA-3",   url: "https://csrc.nist.gov/pubs/fips/202/final" },
  SHA1:     { label: "NIST FIPS 202 — SHA-3",   url: "https://csrc.nist.gov/pubs/fips/202/final" },
  RC4:      { label: "NIST SP 800-175B",         url: "https://csrc.nist.gov/publications/detail/sp/800-175b/rev-1/final" },
  DES:      { label: "NIST SP 800-131A",         url: "https://csrc.nist.gov/pubs/sp/800/131/a/r2/final" },
  "3DES":   { label: "NIST SP 800-131A",         url: "https://csrc.nist.gov/pubs/sp/800/131/a/r2/final" },
  "AES-128":{ label: "NIST SP 800-57",           url: "https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final" },
  Kyber:    { label: "NIST FIPS 203 — ML-KEM",  url: "https://csrc.nist.gov/pubs/fips/203/final" },
  Dilithium:{ label: "NIST FIPS 204 — ML-DSA",  url: "https://csrc.nist.gov/pubs/fips/204/final" },
  SPHINCS:  { label: "NIST FIPS 205 — SLH-DSA", url: "https://csrc.nist.gov/pubs/fips/205/final" },
};
function getVulnRef(algorithm: string) {
  if (VULN_REFS[algorithm]) return VULN_REFS[algorithm];
  const up = algorithm.toUpperCase();
  for (const [k, v] of Object.entries(VULN_REFS)) {
    if (up.startsWith(k.toUpperCase()) || k.toUpperCase().startsWith(up)) return v;
  }
  return { label: "NIST PQC Guidelines", url: "https://csrc.nist.gov/projects/post-quantum-cryptography" };
}

// ── Bottom panel ──────────────────────────────────────────────────────────────
type BottomTab = "problems" | "output" | "debug";
function BottomPanel({ open, onToggle, activeTab, onTabChange, findings, outputLogs, scanState, height, onResizeMD, onAskAI }: {
  open: boolean; onToggle: () => void; activeTab: BottomTab; onTabChange: (t: BottomTab) => void;
  findings: Finding[]; outputLogs: string[]; scanState: string;
  height: number; onResizeMD: (e: React.MouseEvent) => void;
  onAskAI: (f: Finding) => void;
}) {
  const critCount  = findings.filter(f => f.severity === "critical").length;
  const alertCount = findings.filter(f => f.severity === "alert").length;
  const [explains, setExplains] = useState<Record<string, { loading: boolean; text: string }>>({});
  const [filterSev, setFilterSev] = useState<"all" | "critical" | "alert">("all");

  // Reset filter when findings list changes
  useEffect(() => { setFilterSev("all"); }, [findings]);

  const filteredFindings = filterSev === "all"
    ? findings
    : findings.filter(f => f.severity === filterSev);

  const explain = async (f: Finding) => {
    const key = `${f.lineNumber}-${f.algorithm}`;
    setExplains(prev => ({ ...prev, [key]: { loading: true, text: "" } }));
    try {
      const res = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: `In 2-3 sentences, explain why ${f.algorithm} is quantum-vulnerable and which NIST-approved algorithm should replace it.` }],
          systemContext: f.codeSnippet ? `Vulnerable code context:\n${f.codeSnippet}` : "",
          briefMode: true,
        }),
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buf = ""; let text = "";
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.done) break;
            if (d.content) { text += d.content; setExplains(prev => ({ ...prev, [key]: { loading: false, text } })); }
          } catch {}
        }
      }
    } catch {
      const key = `${f.lineNumber}-${f.algorithm}`;
      setExplains(prev => ({ ...prev, [key]: { loading: false, text: "Could not reach AI. Please try again." } }));
    }
  };
  return (
    <div className={cn("border-t border-[#e5e7eb] bg-[#f7f8fa] flex flex-col shrink-0 relative")}
      style={{ height: open ? height : 32 }}>
      {open && (
        <div onMouseDown={onResizeMD}
          className="absolute top-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-[#4f46e5]/30 transition-colors z-20"
          title="Drag to resize panel" />
      )}
      <div className="h-8 flex items-center shrink-0 bg-[#f7f8fa]">
        <div className="flex items-center flex-1 overflow-x-auto">
          {(["problems","output","debug"] as BottomTab[]).map(tab => (
            <button key={tab} onClick={() => { onTabChange(tab); if (!open) onToggle(); }}
              className={cn(
                "h-8 px-4 text-[11px] font-medium uppercase tracking-wide shrink-0 flex items-center gap-1.5 border-b-2 transition-colors",
                activeTab === tab && open ? "border-[#4f46e5] text-[#4f46e5]" : "border-transparent text-[#6b7280] hover:text-[#0a0e1a]",
              )}
            >
              {tab === "problems" && <AlertTriangle className="h-3 w-3" />}
              {tab === "output"   && <TerminalIcon className="h-3 w-3" />}
              {tab === "debug"    && <Bug className="h-3 w-3" />}
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab === "problems" && critCount + alertCount > 0 && (
                <span className="ml-1 bg-red-500/20 text-red-600 text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-red-500/30">
                  {critCount + alertCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 px-2">
          <button onClick={onToggle} className="p-1 text-[#6b7280] hover:text-[#334155] transition-colors">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
          <button className="p-1 text-[#6b7280] hover:text-[#334155] transition-colors">
            <Maximize2 className="h-3 w-3" />
          </button>
          <button onClick={onToggle} className="p-1 text-[#6b7280] hover:text-[#334155] transition-colors">
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      {open && (
        <ScrollArea className="flex-1">
          <div className="p-2 font-mono text-[11px]">
            {activeTab === "problems" && (
              findings.length === 0
                ? <div className="flex items-center gap-2 text-[#6b7280] p-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    {scanState === "idle" ? "Run a scan to detect problems." : "No problems found."}
                  </div>
                : <>
                  {/* ── Severity filter pills ── */}
                  <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                    {(["all","critical","alert"] as const).map(sev => {
                      const count = sev === "all" ? findings.length : sev === "critical" ? critCount : alertCount;
                      const isActive = filterSev === sev;
                      return (
                        <button key={sev} onClick={() => setFilterSev(sev)}
                          className={cn(
                            "flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[10px] font-semibold border transition-colors",
                            sev === "all"
                              ? isActive ? "bg-[#eef0fe] border-[#d5d9e0] text-[#0a0e1a]" : "bg-transparent border-[#e5e7eb] text-[#6b7280] hover:text-[#334155]"
                              : sev === "critical"
                              ? isActive ? "bg-red-500/20 border-red-500/40 text-red-600"    : "bg-transparent border-red-500/15 text-red-500/60 hover:text-red-600"
                              : isActive ? "bg-yellow-500/20 border-yellow-500/40 text-amber-700" : "bg-transparent border-yellow-500/15 text-amber-600/60 hover:text-amber-600",
                          )}>
                          {sev === "critical" && <AlertTriangle className="h-2.5 w-2.5" />}
                          {sev === "alert"    && <Zap           className="h-2.5 w-2.5" />}
                          {sev === "all" ? "All" : sev.charAt(0).toUpperCase() + sev.slice(1)}
                          <span className={cn(
                            "ml-0.5 px-1 rounded-full text-[9px] font-bold",
                            sev === "all"      ? "bg-[#eef0fe] text-[#475569]"
                            : sev === "critical" ? "bg-red-500/20 text-red-600"
                            : "bg-yellow-500/20 text-amber-600",
                          )}>{count}</span>
                        </button>
                      );
                    })}
                    {filterSev !== "all" && (
                      <span className="text-[10px] text-[#9aa3b2] ml-1 font-mono">
                        showing {filteredFindings.length} of {findings.length}
                      </span>
                    )}
                  </div>
                  {filteredFindings.map((f, i) => {
                  const key  = `${f.lineNumber}-${f.algorithm}`;
                  const ref  = getVulnRef(f.algorithm);
                  const expl = explains[key];
                  return (
                    <div key={i} className={cn(
                      "rounded-md mb-2 overflow-hidden border",
                      f.severity === "critical" ? "border-red-500/25 bg-red-500/5" : "border-yellow-500/25 bg-yellow-500/5"
                    )}>
                      {/* Info row */}
                      <div className="flex items-center gap-2 px-2.5 pt-2 pb-1 flex-wrap">
                        {f.severity === "critical"
                          ? <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                          : <Zap className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
                        <span className="text-[#6b7280] font-mono text-[10px] shrink-0">L{f.lineNumber}</span>
                        <span className={cn(
                          "text-[9px] font-bold tracking-wider px-1.5 py-px rounded shrink-0",
                          f.severity === "critical" ? "bg-red-500/20 text-red-600" : "bg-yellow-500/20 text-amber-600",
                        )}>{f.severity.toUpperCase()}</span>
                        <span className="text-[11px] flex-1 min-w-0">
                          <span className="font-mono text-[#0a0e1a]">{f.algorithm}</span>
                          {/* Never assert "is quantum-vulnerable" over every finding — MD5, SHA-1 and
                              AES-ECB are classical hygiene and the claim is false for them (G-08/G-09).
                              The bucket comes from the mapping engine. */}
                          <span className="text-[#475569]">{f.compliance ? ` — ${f.compliance.bucketLabel.toLowerCase()}` : " is quantum-vulnerable"}</span>
                        </span>
                        {f.compliance?.detection.reviewRequired && (
                          <span className="text-[9px] font-bold tracking-wider px-1.5 py-px rounded shrink-0 bg-[#f1f3f7] text-[#6b7280] border border-[#e5e7eb]">
                            NEEDS REVIEW
                          </span>
                        )}
                        {f.nistReplacement && (
                          <span className="text-emerald-600 text-[10px] font-mono shrink-0">→ {f.nistReplacement}</span>
                        )}
                      </div>
                      {/* Action buttons */}
                      <div className="flex items-center gap-1.5 px-2.5 pb-2 flex-wrap">
                        <button
                          onClick={() => explain(f)}
                          disabled={expl?.loading}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-[#4f46e5]/8 border border-[#4f46e5]/25 text-[#4f46e5] hover:bg-[#4f46e5]/15 transition-colors disabled:opacity-50 shrink-0"
                        >
                          <Sparkles className="h-2.5 w-2.5" />
                          {expl?.loading ? "Thinking…" : expl?.text ? "Re-explain" : "Explain with AI"}
                        </button>
                        <a href={ref.url} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-[#f1f3f7] border border-[#e5e7eb] text-[#475569] hover:text-[#0a0e1a] hover:border-[#d5d9e0] transition-colors shrink-0"
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          {ref.label}
                        </a>
                        <button onClick={() => onAskAI(f)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-[#f1f3f7] border border-[#e5e7eb] text-[#475569] hover:text-[#4f46e5] hover:border-[#4f46e5]/25 transition-colors shrink-0 ml-auto"
                        >
                          <MessageSquare className="h-2.5 w-2.5" />
                          Ask AI
                        </button>
                      </div>
                      {/* Inline explanation */}
                      {(expl?.loading || expl?.text) && (
                        <div className="px-3 pt-1.5 pb-2.5 border-t border-[#e5e7eb] bg-[#f7f8fa] text-[11px] text-[#334155] leading-relaxed">
                          {expl.loading && !expl.text
                            ? <span className="flex items-center gap-2 text-[#6b7280]">
                                <span className="h-2 w-2 rounded-full bg-[#4f46e5] animate-pulse shrink-0" />
                                Generating explanation…
                              </span>
                            : expl.text}
                        </div>
                      )}
                    </div>
                  );
                })}
                </>
            )}
            {activeTab === "output" && (
              outputLogs.length === 0
                ? <span className="text-[#6b7280] p-2 block">No output. Run a scan.</span>
                : outputLogs.map((log, i) => <div key={i} className="py-0.5 text-[#334155] leading-relaxed">{log}</div>)
            )}
            {activeTab === "debug" && (
              findings.length === 0
                ? <span className="text-[#6b7280] p-2 block">Debug output appears here after a scan.</span>
                : findings.map((f, i) => (
                  <div key={i} className="py-1 border-b border-[#eceef2]">
                    <span style={{ color: "#4f46e5" }}>quantaxscan</span><span className="text-[#9aa3b2]"> &gt; </span>
                    <span className="text-[#334155]">algorithm=</span><span className="text-amber-600">{f.algorithm}</span>
                    <span className="text-[#334155]"> line=</span><span className="text-cyan-700">{f.lineNumber}</span>
                    <span className="text-[#334155]"> effort=</span><span className="text-cyan-700">{f.effortHours}h</span>
                    {f.nistReplacement && <span className="text-[#334155]"> fix=<span className="text-emerald-600">{f.nistReplacement}</span></span>}
                  </div>
                ))
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────
function ChatPanel({ open, onToggle, findings, scanState, width, onResizeMD, triggerMsg, onTriggerConsumed }: {
  open: boolean; onToggle: () => void;
  findings: Finding[]; scanState: string;
  width: number; onResizeMD: (e: React.MouseEvent) => void;
  triggerMsg: { id: number; text: string; context: string } | null;
  onTriggerConsumed: () => void;
}) {
  const STORAGE_KEY = "quantaxscan_sessions_local";
  const [sessions, setSessions]           = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput]                 = useState("");
  const [isStreaming, setIsStreaming]     = useState(false);
  const [showSessions, setShowSessions]  = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendFnRef = useRef<((overrideText?: string, overrideCtx?: string) => Promise<void>) | undefined>(undefined);
  const formatAssistantText = useCallback((content: string) => content, []);

  // Load sessions from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSessions(JSON.parse(raw));
    } catch {}
  }, [STORAGE_KEY]);

  // Persist sessions
  useEffect(() => {
    if (sessions.length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions, STORAGE_KEY]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [sessions, activeSessionId]);

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;

  const sendMessage = useCallback(async (overrideText?: string, overrideCtx?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || isStreaming) return;
    if (!overrideText) setInput("");

    const userMsg: ChatMsg = { id: `u_${Date.now()}`, role: "user", content: text };
    const assistantMsg: ChatMsg = { id: `a_${Date.now()}`, role: "assistant", content: "" };

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = `s_${Date.now()}`;
      const newSession: ChatSession = {
        id: sessionId, title: text.slice(0, 45),
        messages: [userMsg, assistantMsg], createdAt: new Date().toISOString(),
      };
      setSessions(prev => [newSession, ...prev]);
      setActiveSessionId(sessionId);
    } else {
      setSessions(prev => prev.map(s => s.id === sessionId
        ? { ...s, messages: [...s.messages, userMsg, assistantMsg] }
        : s
      ));
    }

    setIsStreaming(true);
    const sessionMessages = [...(activeSession?.messages ?? []), userMsg];
    const systemContext = overrideCtx ?? (findings.length > 0
      ? `Give a short, clean response with only the most important points.\nUse 3-5 bullets max.\nBold the key risk, the fix, and the next step.\nAvoid long explanations.\n\nScan findings:\n${findings.map(f =>
          `• Line ${f.lineNumber}: ${f.algorithm} [${f.compliance?.bucketLabel ?? f.severity.toUpperCase()}]${f.compliance ? `\n  ${f.compliance.headline}` : ""}${f.nistReplacement ? ` → replace with ${f.nistReplacement}` : ""}${f.codeSnippet ? `\n  Code: ${f.codeSnippet}` : ""}`
        ).join("\n")}`
      : "Give a short, clean response with only the most important points. Use 3-5 bullets max. Bold key risk, fix, and next step.");

    try {
      const res = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: sessionMessages.map(m => ({ role: m.role, content: m.content })),
          systemContext,
        }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.done) break;
            if (data.content) {
              setSessions(prev => prev.map(s => s.id === sessionId ? {
                ...s,
                messages: s.messages.map((m, i) =>
                  i === s.messages.length - 1 ? { ...m, content: formatAssistantText(m.content + data.content) } : m
                ),
              } : s));
            }
          } catch {}
        }
      }
    } catch {
      setSessions(prev => prev.map(s => s.id === sessionId ? {
        ...s,
        messages: s.messages.map((m, i) =>
          i === s.messages.length - 1 ? { ...m, content: "Sorry, I couldn't connect to the AI service. Please try again." } : m
        ),
      } : s));
    }
    setIsStreaming(false);
  }, [input, isStreaming, activeSessionId, activeSession, findings]);

  // Keep ref to latest sendMessage so the trigger effect never has stale closure
  useEffect(() => { sendFnRef.current = sendMessage; }, [sendMessage]);

  // Auto-send when external trigger fires (e.g. "Ask AI" from Problems panel)
  useEffect(() => {
    if (!triggerMsg) return;
    onTriggerConsumed();
    const fn = sendFnRef.current;
    if (fn) setTimeout(() => fn(triggerMsg.text, triggerMsg.context), 80);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerMsg]);

  const newSession = () => { setActiveSessionId(null); };
  const deleteSession = (id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (next.length === 0) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    if (activeSessionId === id) setActiveSessionId(null);
  };

  if (!open) {
    return (
      <button onClick={onToggle}
        className="w-10 border-l border-[#e5e7eb] bg-[#f7f8fa] flex flex-col items-center pt-3 shrink-0 hover:bg-[#f1f3f7] transition-colors">
        <MessageSquare className="h-4 w-4 text-[#6b7280]" />
      </button>
    );
  }

  return (
    <div className="border-l border-[#e5e7eb] bg-[#f7f8fa] flex flex-col shrink-0 relative" style={{ width }}>
      <div onMouseDown={onResizeMD}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[#4f46e5]/30 transition-colors z-20"
        title="Drag to resize chat" />
      {/* Header */}
      <div className="h-9 flex items-center justify-between px-3 border-b border-[#e5e7eb] shrink-0">
        <span className="text-[11px] font-semibold tracking-wider text-[#475569] uppercase">Chat — QuantaXscan AI</span>
        <div className="flex gap-1">
          <button onClick={newSession} title="New chat" className="p-1 hover:bg-[#eef0fe] rounded transition-colors"><Plus className="h-3.5 w-3.5 text-[#6b7280]" /></button>
          <button onClick={onToggle} className="p-1 hover:bg-[#eef0fe] rounded transition-colors"><X className="h-3.5 w-3.5 text-[#6b7280]" /></button>
        </div>
      </div>

      {/* Sessions list */}
      {!activeSessionId && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <button onClick={() => setShowSessions(v => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-semibold tracking-wider text-[#6b7280] hover:text-[#334155] uppercase shrink-0">
            {showSessions ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Sessions
            {sessions.length > 0 && <span className="ml-auto text-[#9aa3b2]">{sessions.length}</span>}
          </button>
          {showSessions && (
            <ScrollArea className="flex-1">
              {sessions.length === 0 ? (
                <div className="flex flex-col items-center text-center px-4 pt-8">
                    <div className="h-10 w-10 rounded-xl bg-[#4f46e5]/10 border border-[#4f46e5]/25 flex items-center justify-center mb-3">
                      <Atom className="h-5 w-5 text-[#4f46e5]" />
                  </div>
                  <p className="text-[11px] text-[#6b7280] leading-relaxed">
                    No sessions yet. Start a conversation about your scan results.
                  </p>
                </div>
              ) : (
                <div className="pb-2">
                  {sessions.map(s => (
                    <div key={s.id} className="group flex items-start gap-2 px-3 py-2 hover:bg-[#f1f3f7] transition-colors cursor-pointer" onClick={() => setActiveSessionId(s.id)}>
                      <div className="h-1.5 w-1.5 rounded-full bg-[#4f46e5] mt-2 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] text-[#334155] truncate font-mono">{s.title}</p>
                        <p className="text-[10px] text-[#9aa3b2]">{new Date(s.createdAt).toLocaleDateString()}</p>
                      </div>
                      <button onClick={e => { e.stopPropagation(); deleteSession(s.id); }}
                        className="p-1 opacity-0 group-hover:opacity-100 text-[#9aa3b2] hover:text-red-600 transition-all">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          )}
        </div>
      )}

      {/* Active session chat */}
      {activeSessionId && activeSession && (
        <>
          {/* Back + session title */}
          <button onClick={() => setActiveSessionId(null)}
            className="flex items-center gap-2 px-3 py-2 text-[11px] text-[#6b7280] hover:text-[#334155] border-b border-[#e5e7eb] transition-colors shrink-0">
            <ChevronRight className="h-3 w-3 rotate-180" />
            <span className="truncate font-mono">{activeSession.title}</span>
          </button>
          <ScrollArea className="flex-1 px-3 py-2">
            {activeSession.messages.map((m, i) => (
              <div key={m.id} className={cn("mb-3", m.role === "user" && "flex justify-end")}>
                {m.role === "assistant" && (
                  <div className="flex items-start gap-2">
                    <div className="h-5 w-5 rounded bg-[#4f46e5]/15 border border-[#4f46e5]/35 flex items-center justify-center shrink-0 mt-0.5">
                      <Atom className="h-3 w-3 text-[#4f46e5]" />
                    </div>
                    <div className="flex-1 bg-[#f1f3f7] rounded-lg p-2.5 text-[11px] text-[#334155] leading-relaxed">
                      {m.content === "" && isStreaming && i === activeSession.messages.length - 1
                        ? <span className="inline-block h-3 w-3 rounded-full bg-[#4f46e5] animate-pulse" />
                        : m.content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) => {
                            if (part.startsWith("**") && part.endsWith("**")) return <strong key={j} className="text-[#0a0e1a] font-semibold">{part.slice(2, -2)}</strong>;
                            if (part.startsWith("`") && part.endsWith("`")) return <code key={j} className="bg-[#f1f3f7] text-emerald-600 px-1 rounded text-[10px] font-mono">{part.slice(1, -1)}</code>;
                            return <span key={j}>{part}</span>;
                          })
                      }
                    </div>
                  </div>
                )}
                {m.role === "user" && (
                  <div className="bg-[#4f46e5]/10 border border-[#4f46e5]/25 rounded-lg px-3 py-2 text-[11px] text-[#0a0e1a] max-w-[85%]">
                    {m.content}
                  </div>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </ScrollArea>
        </>
      )}

      {/* Input */}
      <div className="border-t border-[#e5e7eb] p-2 shrink-0">
        <div className="flex items-end gap-1.5 bg-[#f1f3f7] border border-[#4f46e5]/12 rounded-lg px-2.5 py-2 focus-within:border-[#4f46e5]/35 transition-colors">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }}}
            placeholder="Ask about your scan…"
            rows={1}
            className="flex-1 bg-transparent text-[11px] text-[#0a0e1a] placeholder-[#9aa3b2] resize-none focus:outline-none font-sans leading-relaxed"
            style={{ maxHeight: 80 }}
            disabled={isStreaming}
          />
          {/* Wrapped, not passed directly: sendMessage's first parameter is `overrideText`, so
              binding it to onClick handed the React MouseEvent in as the message body. */}
          <button onClick={() => { void sendMessage(); }} disabled={!input.trim() || isStreaming}
            className="p-1 text-[#4f46e5]/70 hover:text-[#4f46e5] disabled:opacity-30 transition-colors shrink-0">
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="text-[9px] text-right mt-1">
          <span className="text-[#9aa3b2] tracking-wide">
            Powered by QuantaXscan AI
          </span>
        </p>
      </div>
    </div>
  );
}

// ── Clean light scan progress overlay ─────────────────────────────────────────
function SpaceScanOverlay({ current, total, currentFile, projectName }: {
  current: number; total: number; currentFile: string; projectName: string;
}) {
  const pct      = total > 0 ? Math.round((current / total) * 100) : 0;
  const sweepRef = useRef<HTMLDivElement>(null);

  /* ── dot-grid SVG background ──────────────────────────────────────── */
  const dotGrid =
    "url(\"data:image/svg+xml,%3Csvg width='28' height='28' viewBox='0 0 28 28' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='1' cy='1' r='1' fill='%234f46e5' fill-opacity='0.09'/%3E%3C/svg%3E\")";

  /* ── last few files to show as ticker ────────────────────────────── */
  const [ticker, setTicker] = useState<string[]>([]);
  useEffect(() => {
    if (!currentFile) return;
    setTicker(prev => {
      const next = [currentFile, ...prev.filter(f => f !== currentFile)].slice(0, 6);
      return next;
    });
  }, [currentFile]);

  const overlay = (
    <motion.div
      key="scan-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="fixed inset-0 z-[9999] flex items-center justify-center select-none overflow-hidden"
      style={{
        background: "radial-gradient(ellipse 110% 90% at 50% 10%, #eef0fe 0%, #f4f6ff 35%, #ffffff 70%)",
        backgroundImage: dotGrid,
      }}
    >
      {/* ── ambient glow blobs ─────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          animate={{ scale: [1, 1.15, 1], opacity: [0.22, 0.38, 0.22] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          className="absolute -top-32 left-1/2 -translate-x-1/2 h-[420px] w-[420px] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(79,70,229,0.18) 0%, transparent 70%)" }}
        />
        <motion.div
          animate={{ scale: [1, 1.08, 1], opacity: [0.14, 0.25, 0.14] }}
          transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
          className="absolute bottom-0 right-1/4 h-[300px] w-[300px] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(13,148,136,0.15) 0%, transparent 70%)" }}
        />
      </div>

      {/* ── main card ─────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
        className="relative z-10 flex flex-col items-center gap-7 max-w-[420px] w-full mx-6 text-center"
      >
        {/* ── radar ring assembly ────────────────────────────────── */}
        <div className="relative flex items-center justify-center" style={{ width: 180, height: 180 }}>

          {/* outermost pulse ring */}
          <motion.div
            animate={{ scale: [1, 1.18, 1], opacity: [0.25, 0, 0.25] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut" }}
            className="absolute rounded-full border border-[#4f46e5]/30"
            style={{ width: 180, height: 180 }}
          />
          {/* secondary pulse */}
          <motion.div
            animate={{ scale: [1, 1.12, 1], opacity: [0.35, 0.05, 0.35] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut", delay: 0.6 }}
            className="absolute rounded-full border border-[#4f46e5]/25"
            style={{ width: 148, height: 148 }}
          />

          {/* static outer track */}
          <div
            className="absolute rounded-full border border-[#4f46e5]/12"
            style={{ width: 148, height: 148 }}
          />

          {/* spinning dashed ring */}
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
            className="absolute rounded-full"
            style={{
              width: 148, height: 148,
              border: "1.5px dashed rgba(79,70,229,0.2)",
            }}
          />

          {/* spinning solid arc (scanner beam boundary) */}
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
            className="absolute rounded-full"
            style={{
              width: 118, height: 118,
              border: "2px solid transparent",
              borderTop: "2px solid #4f46e5",
              borderRight: "2px solid rgba(79,70,229,0.35)",
            }}
          />

          {/* counter-spinning inner arc */}
          <motion.div
            animate={{ rotate: -360 }}
            transition={{ duration: 3.6, repeat: Infinity, ease: "linear" }}
            className="absolute rounded-full"
            style={{
              width: 88, height: 88,
              border: "1.5px solid transparent",
              borderBottom: "1.5px solid rgba(13,148,136,0.55)",
              borderLeft: "1.5px solid rgba(13,148,136,0.2)",
            }}
          />

          {/* radar sweep — conic gradient rotating */}
          <motion.div
            ref={sweepRef}
            animate={{ rotate: 360 }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
            className="absolute rounded-full overflow-hidden"
            style={{ width: 118, height: 118 }}
          >
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  "conic-gradient(from 270deg, rgba(79,70,229,0.0) 0deg, rgba(79,70,229,0.18) 60deg, rgba(79,70,229,0.38) 90deg, rgba(79,70,229,0.0) 91deg)",
              }}
            />
          </motion.div>

          {/* center icon */}
          <motion.div
            animate={{ boxShadow: ["0 0 0 0 rgba(79,70,229,0.15)", "0 0 0 12px rgba(79,70,229,0)", "0 0 0 0 rgba(79,70,229,0.15)"] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="relative z-10 h-14 w-14 rounded-full bg-white border border-[#4f46e5]/20 flex items-center justify-center shadow-[0_4px_16px_rgba(79,70,229,0.18)]"
          >
            <Shield className="h-6 w-6 text-[#4f46e5]" />
          </motion.div>
        </div>

        {/* ── title ─────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-[#4f46e5] tracking-[0.22em] uppercase">
            QuantaXscan · Quantum Analysis
          </p>
          <h2 className="text-[22px] font-bold text-[#0a0e1a] tracking-tight leading-snug">
            Scanning cryptographic primitives
          </h2>
          <p className="text-[12px] text-[#6b7280] truncate max-w-[340px]">{projectName}</p>
        </div>

        {/* ── live file ticker ──────────────────────────────────────── */}
        <div className="w-full rounded-xl bg-white border border-[#e5e7eb] shadow-[0_8px_32px_rgba(15,23,42,0.07)] overflow-hidden">
          {/* active file */}
          <div className="px-4 py-3 border-b border-[#f1f3f7]">
            <p className="text-[9px] font-semibold text-[#4f46e5] uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
              <motion.span
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.1, repeat: Infinity }}
                className="h-1.5 w-1.5 rounded-full bg-[#4f46e5] inline-block"
              />
              Analyzing
            </p>
            <p className="text-[13px] text-[#0a0e1a] font-mono truncate">
              {currentFile || "Initializing scanner…"}
            </p>
          </div>

          {/* recent files */}
          {ticker.slice(1, 4).length > 0 && (
            <div className="divide-y divide-[#f7f8fa]">
              {ticker.slice(1, 4).map((f, i) => (
                <motion.div
                  key={f}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1 - i * 0.25, x: 0 }}
                  transition={{ duration: 0.25 }}
                  className="px-4 py-1.5 flex items-center gap-2"
                >
                  <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                  <span className="text-[11px] text-[#9aa3b2] font-mono truncate">{f}</span>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* ── progress ──────────────────────────────────────────────── */}
        <div className="w-full space-y-2.5">
          <div className="flex items-center justify-between text-[11px] font-mono">
            <span className="text-[#6b7280]">{current} of {total} file{total !== 1 ? "s" : ""}</span>
            <motion.span
              key={pct}
              initial={{ scale: 1.2, color: "#4f46e5" }}
              animate={{ scale: 1, color: "#4338ca" }}
              className="font-bold tabular-nums"
            >
              {pct}%
            </motion.span>
          </div>

          {/* segmented bar */}
          {total > 0 && total <= 40 ? (
            <div className="flex gap-[3px] h-2">
              {Array.from({ length: total }, (_, i) => (
                <motion.div
                  key={i}
                  initial={false}
                  animate={{
                    background: i < current
                      ? "linear-gradient(90deg,#4f46e5,#4338ca)"
                      : i === current
                      ? "rgba(79,70,229,0.45)"
                      : "#eceef2",
                  }}
                  transition={{ duration: 0.3 }}
                  className="flex-1 rounded-full"
                />
              ))}
            </div>
          ) : (
            <div className="h-2 bg-[#f1f3f7] rounded-full overflow-hidden">
              <motion.div
                className="h-full rounded-full"
                initial={{ width: "0%" }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                style={{ background: "linear-gradient(90deg,#4f46e5,#4338ca,#0d9488)" }}
              />
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );

  return createPortal(overlay, document.body);
}

// ── Upload file tree (ZIP / multi-file uploads) ────────────────────────────────
type UploadTreeNode =
  | { type: "file";   tab: Tab; key: string }
  | { type: "folder"; name: string; folderKey: string; children: UploadTreeNode[] };

function buildUploadTree(tabs: Tab[]): UploadTreeNode[] {
  const root: UploadTreeNode[] = [];
  const folderMap = new Map<string, UploadTreeNode & { type: "folder" }>();
  for (const tab of tabs) {
    const rawPath = tab.path || tab.label;
    const parts = rawPath.split("/").filter(Boolean);
    if (parts.length <= 1) {
      root.push({ type: "file", tab, key: tab.id });
    } else {
      let currentList = root;
      let pathSoFar = "";
      for (let i = 0; i < parts.length - 1; i++) {
        const folderName = parts[i];
        pathSoFar = pathSoFar ? `${pathSoFar}/${folderName}` : folderName;
        let folder = folderMap.get(pathSoFar) as (UploadTreeNode & { type: "folder" }) | undefined;
        if (!folder) {
          folder = { type: "folder", name: folderName, folderKey: pathSoFar, children: [] };
          folderMap.set(pathSoFar, folder);
          currentList.push(folder);
        }
        currentList = folder.children;
      }
      currentList.push({ type: "file", tab, key: tab.id });
    }
  }
  return root;
}

function UploadedTreeNode({ node, depth, activeTabId, collapsed, onToggle, onSelect, findings, allTabFindings, scanState }: {
  node: UploadTreeNode; depth: number; activeTabId: string;
  collapsed: Set<string>; onToggle: (k: string) => void;
  onSelect: (id: string) => void;
  findings: { severity: string }[];
  allTabFindings: Record<string, { severity: string }[]>;
  scanState: string;
}) {
  if (node.type === "file") {
    const { tab } = node;
    const isActive = tab.id === activeTabId;
    const isMulti  = Object.keys(allTabFindings).length > 0;
    // Use per-file findings from allTabFindings (multi-scan) or active-tab findings (single scan)
    const nodeFinds = isMulti
      ? (allTabFindings[tab.label] ?? [])
      : (isActive ? findings : []);
    const hasFinds    = scanState === "complete" && nodeFinds.length > 0;
    const hasCritical = hasFinds && nodeFinds.some(f => f.severity === "critical");
    const hasAlert    = hasFinds && !hasCritical && nodeFinds.some(f => f.severity === "alert");
    // A file is "clean" only when multi-scan ran and it has a result with 0 findings
    const isClean     = isMulti && scanState === "complete" && tab.label in allTabFindings && nodeFinds.length === 0;

    const colorClass = hasCritical
      ? isActive
        ? "bg-red-500/12 border-red-400 text-red-700"
        : "bg-red-500/7 border-red-500/50 text-red-600 hover:bg-red-500/14"
      : hasAlert
      ? isActive
        ? "bg-yellow-500/12 border-yellow-400 text-amber-700"
        : "bg-yellow-500/7 border-yellow-500/50 text-amber-700 hover:bg-yellow-500/14"
      : isClean
      ? isActive
        ? "bg-emerald-500/10 border-emerald-400 text-emerald-600"
        : "bg-emerald-500/5 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10"
      : isActive
        ? "bg-[#4f46e5]/8 text-[#4f46e5] border-[#4f46e5]"
        : "text-[#6b7280] hover:text-[#0a0e1a] hover:bg-[#f1f3f7] border-transparent";

    return (
      <button
        onClick={() => onSelect(tab.id)}
        className={cn(
          "flex items-center gap-1.5 w-full py-[3px] text-[12px] font-mono border-l-2 transition-all",
          colorClass,
        )}
        style={{ paddingLeft: 16 + depth * 12 }}
      >
        <FileIcon ext={tab.ext} />
        <span className="ml-1 flex-1 text-left truncate">{tab.label}</span>
        {hasFinds && (
          <span className={cn(
            "shrink-0 mr-1 text-[10px] font-bold tabular-nums px-1 rounded",
            hasCritical ? "bg-red-500/20 text-red-600" : "bg-yellow-500/20 text-amber-600",
          )}>
            {nodeFinds.length}
          </span>
        )}
        {isClean && (
          <span className="shrink-0 mr-1 text-[10px] text-emerald-600">✓</span>
        )}
      </button>
    );
  }
  const isOpen = !collapsed.has(node.folderKey);
  return (
    <>
      <button
        onClick={() => onToggle(node.folderKey)}
        className="flex items-center gap-1.5 w-full py-[3px] text-[12px] text-[#475569] hover:bg-[#f1f3f7] hover:text-[#0a0e1a] font-mono"
        style={{ paddingLeft: 16 + depth * 12 }}
      >
        {isOpen
          ? <ChevronDown  className="h-3 w-3 text-[#9aa3b2] shrink-0" />
          : <ChevronRight className="h-3 w-3 text-[#9aa3b2] shrink-0" />}
        <FolderSvg open={isOpen} />
        <span className="ml-0.5 truncate">{node.name}</span>
      </button>
      {isOpen && node.children.map(child => (
        <UploadedTreeNode
          key={child.type === "file" ? child.key : child.folderKey}
          node={child} depth={depth + 1} activeTabId={activeTabId}
          collapsed={collapsed} onToggle={onToggle} onSelect={onSelect}
          findings={findings} allTabFindings={allTabFindings} scanState={scanState}
        />
      ))}
    </>
  );
}

// ── Activity bar (no Extensions or Source Control) ────────────────────────────
function ActivityBar({ explorerOpen, chatOpen, onExplorer, onChat }: {
  explorerOpen: boolean; chatOpen: boolean;
  onExplorer: () => void; onChat: () => void;
}) {
  return (
    <div className="w-10 bg-[#f1f3f7] border-r border-[#eceef2] flex flex-col items-center py-1 gap-0.5 shrink-0">
      <button title="Explorer" onClick={onExplorer}
        className={cn("h-10 w-full flex items-center justify-center border-l-2 transition-colors",
          explorerOpen ? "border-[#4f46e5] text-[#4f46e5] bg-[#4f46e5]/5" : "border-transparent text-[#6b7280] hover:text-[#0a0e1a]")}>
        <Files className="h-5 w-5" />
      </button>
      <div className="flex-1" />
      <button title="Chat" onClick={onChat}
        className={cn("h-10 w-full flex items-center justify-center border-l-2 transition-colors",
          chatOpen ? "border-[#4f46e5] text-[#4f46e5] bg-[#4f46e5]/5" : "border-transparent text-[#6b7280] hover:text-[#0a0e1a]")}>
        <Atom className="h-5 w-5" />
      </button>
      <button title="Settings" className="h-10 w-full flex items-center justify-center text-[#9aa3b2] hover:text-[#334155] transition-colors">
        <Settings className="h-5 w-5" />
      </button>
    </div>
  );
}

// ── Summary bar ───────────────────────────────────────────────────────────────
// `children` is deliberately absent: this component renders a button and nothing else — the
// dropdown is portalled by SummaryBar. It used to be declared and required, so every one of the
// five call sites was a type error for failing to pass a prop that was never rendered.
function SummaryPill({
  id, label, dotColor, textColor, labelColor, isOpen, onToggle, noDot = false, dropdownStyle,
}: {
  id: string; label: string; dotColor?: string; textColor: string; labelColor?: string;
  isOpen: boolean; onToggle: () => void; noDot?: boolean;
  dropdownStyle?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onToggle]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={onToggle}
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 border-r border-[#e5e7eb] hover:bg-[#f7f8fa] transition-colors",
          isOpen && "bg-[#f1f3f7]",
        )}
      >
        {!noDot && dotColor && (
          <div className={cn("h-2 w-2 rounded-full shrink-0", dotColor)} />
        )}
        <span className={cn("font-semibold", textColor)}>{label}</span>
        {labelColor && <span className={cn("text-[#9aa3b2]", labelColor)} />}
        <ChevronDown className={cn("h-3 w-3 text-[#9aa3b2] transition-transform", isOpen && "rotate-180")} />
      </button>
    </div>
  );
}

function SummaryBar({ tabFindings, tabs, setActiveTabId }: {
  tabFindings: Record<string, Finding[]>;
  tabs: Tab[];
  setActiveTabId: (id: string) => void;
}) {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const pillRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const toggle = (key: string) => {
    const el = pillRefs.current[key];
    if (el) {
      const r = el.getBoundingClientRect();
      const width = 320;
      const left = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - width - 12));
      const top = Math.min(r.bottom + 6, window.innerHeight - 360);
      setDropdownPos({ top: Math.max(52, top), left });
    }
    setOpenDropdown(p => p === key ? null : key);
  };
  const openTab = useCallback((label: string) => {
    const tab = tabs.find(t => t.label === label);
    if (tab) setActiveTabId(tab.id);
    setOpenDropdown(null);
  }, [tabs, setActiveTabId]);

  const allFinds      = Object.values(tabFindings).flat();
  const totalCritical = allFinds.filter(f => f.severity === "critical").length;
  const totalAlert    = allFinds.filter(f => f.severity === "alert").length;
  const totalEffort   = allFinds.reduce((s, f) => s + (f.effortHours ?? 0), 0);

  // Files bucketed by severity
  const criticalFiles = Object.entries(tabFindings)
    .filter(([, fs]) => fs.some(f => f.severity === "critical"))
    .map(([name, fs]) => ({ name, count: fs.filter(f => f.severity === "critical").length }))
    .sort((a, b) => b.count - a.count);

  const alertFiles = Object.entries(tabFindings)
    .filter(([, fs]) => !fs.some(f => f.severity === "critical") && fs.some(f => f.severity === "alert"))
    .map(([name, fs]) => ({ name, count: fs.filter(f => f.severity === "alert").length }))
    .sort((a, b) => b.count - a.count);

  const cleanFiles = Object.entries(tabFindings)
    .filter(([, fs]) => fs.length === 0)
    .map(([name]) => ({ name }));

  // High-risk ranking: score = critical*3 + alert
  const rankedFiles = Object.entries(tabFindings)
    .filter(([, fs]) => fs.length > 0)
    .map(([name, fs]) => ({
      name,
      shortName: name.split("/").pop() ?? name,
      critical: fs.filter(f => f.severity === "critical").length,
      alert:    fs.filter(f => f.severity === "alert").length,
      score:    fs.filter(f => f.severity === "critical").length * 3 + fs.filter(f => f.severity === "alert").length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Per-file effort: sum effortHours, label with primary algorithm
  const effortByFile = Object.entries(tabFindings)
    .map(([name, fs]) => {
      const effort = fs.reduce((s, f) => s + (f.effortHours ?? 0), 0);
      const algoCounts: Record<string, number> = {};
      for (const f of fs) {
        const a = (f as unknown as Record<string, unknown>)["algorithm"] as string | undefined;
        if (a) algoCounts[a] = (algoCounts[a] ?? 0) + 1;
      }
      const topAlgo = Object.entries(algoCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
      return { name, shortName: name.split("/").pop() ?? name, effort, topAlgo, findings: fs.length };
    })
    .filter(f => f.effort > 0)
    .sort((a, b) => b.effort - a.effort);

  const dropdownStyle = { top: dropdownPos.top, left: dropdownPos.left, width: 320 } as React.CSSProperties;

  return (
    <div className="shrink-0 bg-[#f7f8fa] border-b border-[#e5e7eb] flex items-center px-4 gap-0 font-mono text-[11px] overflow-x-auto relative z-20">
      <span className="text-[9px] tracking-[0.18em] text-[#9aa3b2] uppercase mr-4 shrink-0">Project Scan</span>

      {/* Critical */}
      {totalCritical > 0 && (
        <div ref={el => { pillRefs.current.critical = el; }} className="shrink-0">
          <SummaryPill id="critical" label={`${totalCritical} critical`}
            dotColor="bg-red-500" textColor="text-red-600"
            isOpen={openDropdown === "critical"} onToggle={() => toggle("critical")} />
        </div>
      )}

      {/* Alert */}
      {totalAlert > 0 && (
        <div ref={el => { pillRefs.current.alert = el; }} className="shrink-0">
          <SummaryPill id="alert" label={`${totalAlert} alerts`}
            dotColor="bg-yellow-500" textColor="text-amber-600"
            isOpen={openDropdown === "alert"} onToggle={() => toggle("alert")} />
        </div>
      )}

      {/* Clean */}
      {cleanFiles.length > 0 && (
        <div ref={el => { pillRefs.current.clean = el; }} className="shrink-0">
          <SummaryPill id="clean" label={`${cleanFiles.length} clean`}
            dotColor="bg-emerald-500" textColor="text-emerald-500"
            isOpen={openDropdown === "clean"} onToggle={() => toggle("clean")} />
        </div>
      )}

      {/* High Risk */}
      {rankedFiles.length > 0 && (
        <div ref={el => { pillRefs.current.highrisk = el; }} className="shrink-0">
          <SummaryPill id="highrisk" label="High Risk" textColor="text-[#4f46e5]" noDot
            isOpen={openDropdown === "highrisk"} onToggle={() => toggle("highrisk")} />
        </div>
      )}

      {/* Effort */}
      {totalEffort > 0 && (
        <div ref={el => { pillRefs.current.effort = el; }} className="shrink-0">
          <SummaryPill id="effort" label={`~${Math.ceil(totalEffort)}h effort`} textColor="text-teal-600" noDot
            isOpen={openDropdown === "effort"} onToggle={() => toggle("effort")} />
        </div>
      )}

      {openDropdown && (
        <div className="fixed inset-0 z-[9998]" onMouseDown={() => setOpenDropdown(null)}>
          <div
            className="absolute z-[9999] min-w-[240px] max-w-[360px] bg-[#ffffff] border border-[#e5e7eb] rounded-lg shadow-[0_8px_24px_rgba(15,23,42,0.12)] overflow-hidden"
            style={{ top: dropdownPos.top, left: dropdownPos.left, width: 320 }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="max-h-[320px] overflow-y-auto">
              {openDropdown === "critical" && (
                <>
                  <div className="px-3 py-1.5 border-b border-[#e5e7eb]">
                    <span className="text-[9px] text-[#9aa3b2] uppercase tracking-wider">Files with critical findings</span>
                  </div>
                  {criticalFiles.map(f => (
                    <button key={f.name} onClick={() => openTab(f.name)}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-red-500/8 w-full text-left transition-colors group">
                      <div className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                      <span className="text-[11px] text-[#334155] truncate flex-1 group-hover:text-[#0a0e1a]">{f.name.split("/").pop()}</span>
                      <span className="text-[10px] text-red-600 font-semibold shrink-0">{f.count}</span>
                    </button>
                  ))}
                </>
              )}
              {openDropdown === "alert" && (
                <>
                  <div className="px-3 py-1.5 border-b border-[#e5e7eb]">
                    <span className="text-[9px] text-[#9aa3b2] uppercase tracking-wider">Files with alert findings</span>
                  </div>
                  {alertFiles.map(f => (
                    <button key={f.name} onClick={() => openTab(f.name)}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-yellow-500/8 w-full text-left transition-colors group">
                      <div className="h-1.5 w-1.5 rounded-full bg-yellow-500 shrink-0" />
                      <span className="text-[11px] text-[#334155] truncate flex-1 group-hover:text-[#0a0e1a]">{f.name.split("/").pop()}</span>
                      <span className="text-[10px] text-amber-600 font-semibold shrink-0">{f.count}</span>
                    </button>
                  ))}
                </>
              )}
              {openDropdown === "clean" && (
                <>
                  <div className="px-3 py-1.5 border-b border-[#e5e7eb]">
                    <span className="text-[9px] text-[#9aa3b2] uppercase tracking-wider">Clean files — no findings</span>
                  </div>
                  {cleanFiles.map(f => (
                    <button key={f.name} onClick={() => openTab(f.name)}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-emerald-500/8 w-full text-left transition-colors group">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                      <span className="text-[11px] text-[#334155] truncate flex-1 group-hover:text-[#0a0e1a]">{f.name.split("/").pop()}</span>
                    </button>
                  ))}
                </>
              )}
              {openDropdown === "highrisk" && (
                <>
                  <div className="px-3 py-1.5 border-b border-[#e5e7eb] flex items-center justify-between">
                    <span className="text-[9px] text-[#9aa3b2] uppercase tracking-wider">Top 5 riskiest files</span>
                    <span className="text-[9px] text-[#9aa3b2]">score = crit×3 + alerts</span>
                  </div>
                  {rankedFiles.map((f, i) => (
                    <button key={f.name} onClick={() => openTab(f.name)}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-[#4f46e5]/6 w-full text-left transition-colors group">
                      <span className="text-[10px] text-[#9aa3b2] font-mono w-5 shrink-0 text-right">#{i + 1}</span>
                      <span className="text-[11px] text-[#334155] truncate flex-1 group-hover:text-[#0a0e1a]">{f.shortName}</span>
                      {f.critical > 0 && <span className="text-[10px] text-red-600 font-mono shrink-0">{f.critical}C</span>}
                      {f.alert > 0 && <span className="text-[10px] text-amber-600 font-mono shrink-0">{f.alert}A</span>}
                      <span className="text-[9px] text-[#9aa3b2] font-mono shrink-0">score:{f.score}</span>
                    </button>
                  ))}
                </>
              )}
              {openDropdown === "effort" && (
                <>
                  <div className="px-3 py-1.5 border-b border-[#e5e7eb] flex items-center justify-between">
                    <span className="text-[9px] text-[#9aa3b2] uppercase tracking-wider">Per-file migration effort</span>
                    <span className="text-[9px] text-[#9aa3b2]">total: ~{Math.ceil(totalEffort)}h</span>
                  </div>
                  {effortByFile.map(f => (
                    <button key={f.name} onClick={() => openTab(f.name)}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-teal-500/10 w-full text-left transition-colors group">
                      <Clock className="h-3 w-3 text-teal-600/60 shrink-0" />
                      <span className="text-[11px] text-[#334155] truncate flex-1 group-hover:text-[#0a0e1a]">{f.shortName}</span>
                      <span className="text-[10px] text-teal-600 font-mono shrink-0">~{Math.ceil(f.effort)}h</span>
                      {f.topAlgo && <span className="text-[9px] text-[#9aa3b2] truncate max-w-[90px] shrink-0">{f.topAlgo}</span>}
                    </button>
                  ))}
                  <div className="px-3 py-2 border-t border-[#eceef2] mt-0.5">
                    <p className="text-[9px] text-[#9aa3b2] leading-relaxed">
                      Effort estimated per-finding by the QuantaXscan scanner engine based on algorithm complexity and NIST migration path.
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* File count */}
      <div className="flex items-center gap-1 px-3 py-2 shrink-0 ml-auto">
        <span className="text-[#9aa3b2]">{Object.keys(tabFindings).length} files</span>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
const QUICK_REPOS = [
  { url: "https://github.com/paramiko/paramiko", label: "paramiko/paramiko" },
  { url: "https://github.com/golang/crypto",     label: "golang/crypto" },
  { url: "https://github.com/hashicorp/vault",   label: "hashicorp/vault" },
];

function makeBlankTab(): Tab {
  return { id: `tab_${Date.now()}`, label: "untitled", ext: "txt", langKey: "txt", content: "", dirty: false };
}

export function Scan() {
  const { toast } = useToast();

  // Panel state
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [chatOpen, setChatOpen]         = useState(true);
  const [bottomOpen, setBottomOpen]     = useState(true);
  const [bottomTab, setBottomTab]       = useState<BottomTab>("problems");
  const [collapsed, setCollapsed]       = useState<Set<string>>(new Set());
  // Panel resize dimensions
  const [explorerWidth, setExplorerWidth] = useState(220);
  const [chatWidth, setChatWidth]         = useState(288);
  const [bottomHeight, setBottomHeight]   = useState(176);
  // Chat AI trigger (set by "Ask AI" actions in Problems panel)
  const [chatTrigger, setChatTrigger]     = useState<{ id: number; text: string; context: string } | null>(null);

  // Input mode
  const [inputMode, setInputMode] = useState<"paste" | "github">("paste");

  // Paste scan state
  const [language, setLanguage]         = useState("java");
  const [projectName, setProjectName]   = useState("hello-world");
  const [mode, setMode]                 = useState<CreateScanBodyMode>("scan-only");
  const [scanState, setScanState]       = useState<"idle" | "scanning" | "complete">("idle");
  const [currentLine, setCurrentLine]   = useState(0);
  const [activeScanId, setActiveScanId] = useState<number | null>(null);
  const [outputLogs, setOutputLogs]     = useState<string[]>([]);
  const [srcOpen, setSrcOpen]           = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hasCustomFile, setHasCustomFile] = useState(false);
  const [zipExtracting, setZipExtracting] = useState(false);
  const [zipStats, setZipStats] = useState<{ name: string; total: number; loaded: number } | null>(null);

  // Tabs — start with first sample file for the default language
  const getLangSamples = (lk: string) => LANG_SAMPLES[lk] ?? LANG_SAMPLES.java;
  const [tabs, setTabs]           = useState<Tab[]>(() => {
    const samples = getLangSamples("java");
    return [{ id: "t_init", label: samples[0].name, ext: "java", langKey: "java", content: samples[0].content, path: `src/${samples[0].name}`, sample: true }];
  });
  const [activeTabId, setActiveTabId] = useState("t_init");

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const langKey = activeTab?.langKey ?? getLangKey(language);

  // Navigation
  const [, setLocation] = useLocation();

  // Multi-file scan overlay state (upload mode)
  const [spaceScanOverlay, setSpaceScanOverlay] = useState<{
    current: number; total: number; currentFile: string;
  } | null>(null);

  // Per-tab findings from a full-project multi-file scan (keyed by tab label = filename)
  const [tabFindings, setTabFindings] = useState<Record<string, Finding[]>>({});

  // GitHub two-phase flow
  const [githubUrl, setGithubUrl]           = useState("");
  const [githubPhase, setGithubPhase]       = useState<GitHubPhase>("idle");
  const [fetchedRepo, setFetchedRepo]       = useState<FetchedRepoData | null>(null);
  const [githubResult, setGithubResult]     = useState<GithubScanResult | null>(null);
  const [selectedFile, setSelectedFile]     = useState<GithubFileResult | null>(null);
  const [selectedFullPath, setSelectedFullPath] = useState<string>("");
  const [fetchProgress, setFetchProgress]   = useState("");
  const [scanProgressMsg, setScanProgressMsg] = useState("");
  const [scannedFileCount, setScannedFileCount] = useState(0);
  const [scanningFileName, setScanningFileName] = useState("");
  const [rateLimitHit, setRateLimitHit]     = useState(false);
  const [rateLimitResetAt, setRateLimitResetAt] = useState<number | null>(null);
  // Why the last GitHub action failed. Without this, every failure was reported as a bad URL —
  // including an API rejection, which sends the user back to retype a perfectly valid URL.
  const [githubError, setGithubError]       = useState<{ long: string; short: string } | null>(null);

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed(prev => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n; });
  }, []);

  // API
  const createProject = useCreateProject();
  const createScan    = useCreateScan();
  // queryKey is passed explicitly because the generated options type requires it. The value is
  // the same one the hook derives internally (`queryOptions?.queryKey ?? getGetScanQueryKey(id)`),
  // so this is the type made honest, not a behaviour change.
  const { data: scan }     = useGetScan(activeScanId ?? 0, {
    query: { queryKey: getGetScanQueryKey(activeScanId ?? 0), enabled: !!activeScanId },
  });
  const { data: findings } = useGetScanFindings(activeScanId ?? 0, {
    query: { queryKey: getGetScanFindingsQueryKey(activeScanId ?? 0), enabled: !!activeScanId },
  });

  const onExplorerResizeMD = makeResizeMD(setExplorerWidth, explorerWidth, "x",  1, 150, 500);
  const onChatResizeMD     = makeResizeMD(setChatWidth,     chatWidth,     "x", -1, 200, 540);
  const onBottomResizeMD   = makeResizeMD(setBottomHeight,  bottomHeight,  "y", -1,  48, 450);

  const handleAskAI = useCallback((f: Finding) => {
    const codeBlock = f.codeSnippet ? `\n\`\`\`\n${f.codeSnippet}\n\`\`\`` : "";
    // Don't ask for "the quantum attack vector" on a finding that has nothing to do with
    // quantum computing — the model will invent one. Key the question off the risk track.
    const quantum = f.compliance ? f.compliance.riskTrack === "post-quantum" : true;
    const question = quantum
      ? `What is the quantum attack vector and show me the exact code change to fix it using ${f.nistReplacement ?? "a NIST PQC algorithm"}?`
      : `This is a classical-cryptography finding, not a quantum one. Explain the actual weakness and show me the exact code change to fix it${f.nistReplacement ? ` using ${f.nistReplacement}` : ""}.`;
    const text = `Analyze the **${f.algorithm}** finding at line ${f.lineNumber}${codeBlock}.\n\n${question}`;
    const context = [
      `Finding: ${f.algorithm} at line ${f.lineNumber} (${f.compliance?.bucketLabel ?? f.severity.toUpperCase()})`,
      f.compliance ? `Position: ${f.compliance.headline}` : "",
      f.compliance?.detection.reviewRequired && f.compliance.detection.reason
        ? `Confidence caveat: ${f.compliance.detection.reason}`
        : "",
      f.codeSnippet   ? `Code:\n${f.codeSnippet}` : "",
      f.nistReplacement ? `NIST replacement: ${f.nistReplacement}` : "",
      f.nistStandard  ? `Standard: ${f.nistStandard}` : "",
      f.explanation   ? `Background: ${f.explanation}` : "",
    ].filter(Boolean).join("\n");
    setChatTrigger({ id: Date.now(), text, context });
    setChatOpen(true);
  }, []);

  const addOutput = (msg: string) => setOutputLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // Monotonic tab-id source. `Date.now()` collides when several files are opened in one loop.
  const tabIdSeq = useRef(0);
  const nextTabId = () => `t_${++tabIdSeq.current}_${Date.now()}`;

  // Open file in a new tab (or switch if already open).
  // Opening a *user* file drops the shipped demo-project tabs — otherwise the demo files stay in
  // the project and get scanned alongside the upload, inflating the file count and the findings.
  // A demo tab never counts as "already open" for a user file: `main.py` / `main.go` collide with
  // the shipped samples by name, and switching to the demo tab would scan demo code as the upload.
  const openFileInTab = useCallback((name: string, content: string, lk: string, path?: string, isSample = false) => {
    const existing = tabs.find(t => (isSample || !t.sample) && (t.path === path || t.label === name));
    if (existing) { setActiveTabId(existing.id); return; }
    const id = nextTabId();
    const ext = getExt(name);
    setTabs(prev => [
      ...(isSample ? prev : prev.filter(t => !t.sample)),
      { id, label: name, ext, langKey: lk, content, path, dirty: false, sample: isSample },
    ]);
    setActiveTabId(id);
  }, [tabs]);

  // When language changes, update active tab's langKey
  const handleLanguageChange = (lang: string) => {
    setLanguage(lang);
    const lk = getLangKey(lang);
    // Only reset to the language's sample project while the user has not supplied their own
    // files — otherwise switching language would silently discard the upload.
    if (!hasCustomFile) {
      const samples = getLangSamples(lk);
      const firstSample = samples[0];
      const id = nextTabId();
      setTabs([{ id, label: firstSample.name, ext: lk, langKey: lk, content: firstSample.content, path: `src/${firstSample.name}`, sample: true }]);
      setActiveTabId(id);
    }
    setScanState("idle");
    setActiveScanId(null);
    setOutputLogs([]);
  };

  const CODE_EXTS = new Set(["py","js","ts","tsx","jsx","go","java","cs","cpp","c","rb","php","rs","kt","swift","sh"]);
  const LANG_FROM_EXT: Record<string, string> = {
    py: "python", js: "javascript", ts: "typescript", go: "go",
    java: "java", cpp: "cpp", c: "c", rs: "rust", kt: "kotlin",
    swift: "swift", tsx: "typescript", jsx: "javascript", rb: "ruby", php: "php",
  };

  // ZIP extraction handler
  const handleZipFile = useCallback(async (file: File) => {
    setZipExtracting(true);
    setZipStats({ name: file.name, total: 0, loaded: 0 });
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.entries(zip.files).filter(
        ([name, f]) => !f.dir && CODE_EXTS.has(name.split(".").pop()?.toLowerCase() ?? "")
      ).slice(0, 40);

      if (entries.length === 0) {
        toast({ title: "No code files found", description: "The zip contains no supported code files.", variant: "destructive" });
        return;
      }
      setZipStats({ name: file.name, total: entries.length, loaded: 0 });

      const newTabs: Tab[] = [];
      let firstLang = "";
      for (let i = 0; i < entries.length; i++) {
        const [name, f] = entries[i];
        const content = await f.async("string");
        const label = name.split("/").pop() ?? name;
        const ext = getExt(label);
        const lk = getLangKey("", label);
        newTabs.push({ id: `t_zip_${Date.now()}_${i}`, label, ext, langKey: lk, content, path: name, dirty: false });
        if (i === 0) firstLang = LANG_FROM_EXT[ext] ?? "";
        setZipStats({ name: file.name, total: entries.length, loaded: i + 1 });
      }

      setTabs(newTabs);
      setActiveTabId(newTabs[0].id);
      if (firstLang) setLanguage(firstLang);
      setProjectName(file.name.replace(/\.zip$/i, ""));
      setHasCustomFile(true);
    } catch {
      toast({ title: "Failed to extract zip", description: "Could not read the zip file.", variant: "destructive" });
    } finally {
      setZipExtracting(false);
      setZipStats(null);
    }
  }, []);

  // Single code file handler
  const loadCodeFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const content = (ev.target?.result as string) ?? "";
      const ext = getExt(file.name);
      const lk = getLangKey("", file.name);
      openFileInTab(file.name, content, lk, file.name);
      setHasCustomFile(true);
      if (LANG_FROM_EXT[ext]) setLanguage(LANG_FROM_EXT[ext]);
      setProjectName(file.name.replace(/\.[^.]+$/, ""));
    };
    reader.readAsText(file);
  }, [openFileInTab]);

  // File-input change handler (for the hidden <input type="file">)
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".zip")) {
        void handleZipFile(file);
      } else {
        loadCodeFile(file);
      }
    }
    e.target.value = "";
  }, [handleZipFile, loadCodeFile]);

  // Drag & drop OS files onto editor / upload zone
  const handleEditorDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".zip")) {
        void handleZipFile(file);
      } else {
        loadCodeFile(file);
      }
    }
  }, [handleZipFile, loadCodeFile]);

  // Multi-file scan — scans the whole project at once then shows per-file results inline
  const runMultiFileScan = async () => {
    const files = tabs.map(t => ({ content: t.content, filename: t.label }));
    const total = files.length;
    setTabFindings({});
    setScanState("scanning");
    setSpaceScanOverlay({ current: 0, total, currentFile: "" });
    try {
      const scanPromise = fetch(apiUrl("/api/scans/multi"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName, language, files }),
      });
      const msPerFile = Math.max(180, Math.min(700, 6000 / Math.max(total, 1)));
      for (let i = 0; i < total; i++) {
        setSpaceScanOverlay({ current: i, total, currentFile: files[i].filename });
        await new Promise<void>(r => setTimeout(r, msPerFile));
      }
      setSpaceScanOverlay({ current: total, total, currentFile: "Finalizing results…" });
      const res = await scanPromise;
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as {
        fileResults: {
          filename: string; riskScore: number;
          findings: {
            lineNumber: number; severity: string; algorithm: string;
            codeSnippet: string; nistReplacement: string | null;
            nistStandard: string | null; effortHours: number; explanation: string;
          }[];
        }[];
      };
      // Map per-file findings into the tabFindings record (keyed by filename/label)
      const map: Record<string, Finding[]> = {};
      let idCtr = 0;
      for (const fr of data.fileResults ?? []) {
        map[fr.filename] = fr.findings.map(f => ({
          id: idCtr++, scanId: 0,
          fileName: fr.filename,
          lineNumber: f.lineNumber,
          severity: f.severity as Finding["severity"],
          algorithm: f.algorithm,
          codeSnippet: f.codeSnippet,
          nistReplacement: f.nistReplacement,
          nistStandard: f.nistStandard,
          effortHours: f.effortHours,
          explanation: f.explanation,
        }));
      }
      await new Promise<void>(r => setTimeout(r, 600));
      setSpaceScanOverlay(null);
      setTabFindings(map);
      setScanState("complete");
      setBottomOpen(true);
      setBottomTab("problems");
      addOutput(`Scan complete — ${files.length} files scanned, ${Object.values(map).flat().length} findings.`);
    } catch (err) {
      setSpaceScanOverlay(null);
      setScanState("idle");
      toast({ title: "Scan Failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const startScan = async () => {
    // Multi-file mode: when a ZIP uploaded more than one file
    if (tabs.length > 1 && hasCustomFile) {
      await runMultiFileScan();
      return;
    }
    if (!activeTab?.content.trim()) {
      toast({ title: "Error", description: "Code cannot be empty", variant: "destructive" }); return;
    }
    setScanState("scanning"); setCurrentLine(0);
    setOutputLogs([]); addOutput("Starting quantum vulnerability scan…");
    addOutput(`Language: ${language} | Mode: ${mode}`);
    setBottomOpen(true); setBottomTab("output");
    try {
      const proj = await createProject.mutateAsync({ data: { name: projectName, language, code: activeTab.content } });
      addOutput(`Project created: ${proj.id}`);
      const newScan = await createScan.mutateAsync({ data: { projectId: proj.id, mode, code: activeTab.content, language } });
      setActiveScanId(newScan.id);
      addOutput(`Scan started: ID ${newScan.id}`);
      const codeLines = activeTab.content.split("\n");
      let line = 0;
      const totalLines = codeLines.length;
      const msPerLine  = Math.max(25, Math.min(80, 2400 / Math.max(totalLines, 1)));
      const iv = setInterval(() => {
        if (line < totalLines) {
          setCurrentLine(line++);
        } else {
          clearInterval(iv);
          setScanState("complete");
          addOutput(`Scan complete. ${totalLines} lines analysed.`);
          setBottomOpen(true);
          setBottomTab("problems");
        }
      }, msPerLine);
    } catch {
      setScanState("idle"); addOutput("ERROR: Scan failed.");
      toast({ title: "Scan Failed", description: "An error occurred.", variant: "destructive" });
    }
  };

  // PHASE 1: fetch repo tree + pre-download scannable file contents
  const fetchRepo = async () => {
    if (!githubUrl.trim()) { toast({ title: "Error", description: "Enter a GitHub URL", variant: "destructive" }); return; }
    setGithubPhase("fetching"); setFetchedRepo(null); setGithubResult(null);
    setSelectedFile(null); setSelectedFullPath(""); setRateLimitHit(false); setGithubError(null);
    const msgs = ["Connecting to GitHub API…","Fetching repository tree…","Downloading source files…","Building folder structure…","Almost done…"];
    let mi = 0;
    const iv = setInterval(() => setFetchProgress(msgs[mi++ % msgs.length]), 900);
    try {
      const res  = await fetch(apiUrl("/api/github/fetch"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoUrl: githubUrl.trim() }) });
      clearInterval(iv);
      const data = await res.json() as FetchedRepoData & { error?: string; rateLimit?: boolean; resetAt?: number };
      if (!res.ok) {
        if (data.rateLimit) {
          setRateLimitHit(true);
          setRateLimitResetAt(data.resetAt ? data.resetAt * 1000 : null);
          setGithubError(GITHUB_RATE_LIMIT_ERROR);
          setGithubPhase("error"); return;
        }
        if (res.status === 401 || res.status === 403) {
          setGithubError(GITHUB_AUTH_ERROR);
          setGithubPhase("error");
          toast({ title: "Not authorised", description: GITHUB_AUTH_ERROR.long, variant: "destructive" });
          return;
        }
        if (res.status === 400 || res.status === 404) {
          setGithubError(GITHUB_BAD_URL_ERROR);
          setGithubPhase("error");
          toast({ title: "Repository not found", description: data.error ?? GITHUB_BAD_URL_ERROR.long, variant: "destructive" });
          return;
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setFetchedRepo(data); setGithubPhase("fetched");
      const firstScannable = data.fetchedFiles[0];
      if (firstScannable) setSelectedFullPath(firstScannable.path);
    } catch (err) {
      clearInterval(iv); setGithubPhase("error");
      const detail = err instanceof Error ? err.message : "Failed";
      setGithubError({ long: `Fetch failed — ${detail}`, short: "Fetch failed." });
      toast({ title: "Fetch Failed", description: detail, variant: "destructive" });
    }
  };

  // Picking one of the suggested repos is a fresh start, not a retry of the failed one: clear the
  // previous failure so no stale error copy survives the selection.
  const selectQuickRepo = (url: string) => {
    setGithubUrl(url);
    setRateLimitHit(false);
    setGithubError(null);
    setGithubPhase("idle");
  };

  // PHASE 2: scan the pre-fetched files (no further GitHub API calls)
  const runGithubScan = async () => {
    if (!fetchedRepo?.fetchedFiles?.length) {
      toast({ title: "Nothing to scan", description: "No scannable files were fetched.", variant: "destructive" }); return;
    }
    const files = fetchedRepo.fetchedFiles;
    setGithubPhase("scanning"); setGithubResult(null); setSelectedFile(null);
    setScannedFileCount(0); setScanningFileName(""); setGithubError(null);

    try {
      // Fire the real API call immediately — content is already capped at 300 lines per file
      const scanPromise = fetch(apiUrl("/api/github/scan-files"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: fetchedRepo.repoUrl, owner: fetchedRepo.owner, repo: fetchedRepo.repo, files }),
      });

      // Simultaneously animate per-file progress so the user can see what's happening
      const msPerFile = Math.max(120, Math.min(500, 4000 / Math.max(files.length, 1)));
      for (let i = 0; i < files.length; i++) {
        setScanningFileName(files[i].path);
        setScanProgressMsg(`[${i + 1}/${files.length}] ${files[i].path.split("/").pop()}`);
        await new Promise<void>(r => setTimeout(r, msPerFile));
        setScannedFileCount(i + 1);
      }
      setScanningFileName("");

      const res = await scanPromise;
      let data: GithubScanResult & { error?: string };
      try {
        data = await res.json() as GithubScanResult & { error?: string };
      } catch {
        throw new Error(`Server returned non-JSON response (HTTP ${res.status}). The request body may be too large — try a smaller repo.`);
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setGithubError(GITHUB_AUTH_ERROR);
          setGithubPhase("error");
          toast({ title: "Not authorised", description: GITHUB_AUTH_ERROR.long, variant: "destructive" });
          return;
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      setGithubResult(data);
      setGithubPhase("scanned");

      if (data.fileResults?.length) {
        const first = data.fileResults.find(f => f.criticalCount + f.alertCount > 0) ?? data.fileResults[0];
        setSelectedFile(first); setSelectedFullPath(first.path);
      }
    } catch (err) {
      console.error("[runGithubScan] scan failed:", err);
      setGithubPhase("error");
      const detail = err instanceof Error ? err.message : String(err);
      setGithubError({ long: `Scan failed — ${detail}`, short: "Scan failed." });
      toast({ title: "Scan Failed", description: detail, variant: "destructive" });
    }
  };

  const downloadReport = () => {
    if (!githubResult) return;
    const lines = [`# QUANTAXSCAN Report: ${githubResult.owner}/${githubResult.repo}`, `Risk: ${githubResult.riskScore}/100`, "", ...githubResult.findings.map(f => `- [${f.severity}] ${f.fileName}:${f.lineNumber} — ${f.algorithm}`)];
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
    Object.assign(document.createElement("a"), { href: url, download: `QuantaXscan_${githubResult.repo}.md` }).click();
    URL.revokeObjectURL(url);
  };

  const [sharing, setSharing]   = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const shareReport = async () => {
    if (!githubResult) return;
    setSharing(true);
    try {
      const res = await fetch(apiUrl("/api/reports"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: githubResult.owner,
          repo: githubResult.repo,
          repoUrl: githubResult.repoUrl,
          data: githubResult,
        }),
      });
      const json = await res.json() as { id?: string; shareUrl?: string; error?: string };
      if (!res.ok || !json.id) throw new Error(json.error ?? "Failed to share");
      const fullUrl = `${window.location.origin}/report/${json.id}`;
      await navigator.clipboard.writeText(fullUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 3000);
      toast({ title: "Link copied!", description: "Share URL is in your clipboard." });
    } catch (err) {
      toast({ title: "Share failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" });
    } finally {
      setSharing(false);
    }
  };

  const fileTree = useMemo(() => githubResult ? buildFileTree(githubResult.fileResults) : [], [githubResult]);

  // Full repo tree (all files, built from fetchedRepo, optionally enhanced with scan results)
  const fullRepoTree = useMemo(() => {
    if (!fetchedRepo) return [];
    return buildFullTree(fetchedRepo.fullTree, fetchedRepo.fetchedFiles, githubResult?.fileResults);
  }, [fetchedRepo, githubResult]);

  // Preview file content (before scan) - the selected full-tree node's fetched content
  const previewFile = useMemo<FetchedRepoFile | null>(() => {
    if (!fetchedRepo || !selectedFullPath) return null;
    return fetchedRepo.fetchedFiles.find(f => f.path === selectedFullPath) ?? null;
  }, [fetchedRepo, selectedFullPath]);
  // In multi-file mode tabFindings holds per-tab results; fall back to single-scan findings
  const pasteFindings: Finding[] = useMemo(() => {
    if (Object.keys(tabFindings).length > 0) {
      return tabFindings[activeTab?.label ?? ""] ?? [];
    }
    return findings ?? [];
  }, [tabFindings, activeTab?.label, findings]);
  const selectedFileFindings: Finding[] = useMemo(() => {
    if (!selectedFile?.findings) return [];
    return selectedFile.findings.map((gf, i) => ({
      id: i, scanId: 0, lineNumber: gf.lineNumber, severity: gf.severity,
      algorithm: gf.algorithm, explanation: gf.explanation,
      nistReplacement: gf.nistReplacement, nistStandard: gf.nistStandard,
      effortHours: gf.effortHours, codeSnippet: gf.codeSnippet,
    } as Finding));
  }, [selectedFile]);

  const allGithubFindings: Finding[] = useMemo(() => {
    if (!githubResult?.findings) return [];
    return githubResult.findings.map((gf, i) => ({
      id: i, scanId: 0, lineNumber: gf.lineNumber, severity: gf.severity,
      algorithm: gf.algorithm, explanation: gf.explanation,
      nistReplacement: gf.nistReplacement, nistStandard: gf.nistStandard,
      effortHours: gf.effortHours, codeSnippet: gf.codeSnippet,
    } as Finding));
  }, [githubResult]);

  // ── Download annotated ZIP ──────────────────────────────────────────────────
  const downloadAnnotatedZip = useCallback(async () => {
    const commentPrefix = (ext: string) =>
      ["py","rb","sh","php"].includes(ext) ? "#" : "//";

    const annotate = (
      content: string,
      finds: Array<{ lineNumber: number; severity: string; algorithm: string; nistReplacement?: string | null }>,
      ext: string,
    ) => {
      const pre = commentPrefix(ext);
      const lines = content.split("\n");
      const byLine: Record<number, typeof finds> = {};
      for (const f of finds) {
        const idx = Math.max(0, (f.lineNumber ?? 1) - 1);
        (byLine[idx] ??= []).push(f);
      }
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (byLine[i]) {
          for (const f of byLine[i]) {
            out.push(
              `${pre} [QUANTAXSCAN ${f.severity.toUpperCase()}] ${f.algorithm} is quantum-vulnerable` +
              (f.nistReplacement ? ` → replace with ${f.nistReplacement}` : "")
            );
          }
        }
        out.push(lines[i]);
      }
      return out.join("\n");
    };

    const zip = new JSZip();

    if (inputMode === "paste") {
      for (const tab of tabs) {
        const finds = tab.id === activeTabId ? pasteFindings : [];
        zip.file(tab.label, finds.length ? annotate(tab.content, finds, tab.ext) : tab.content);
      }
    } else if (githubPhase === "scanned" && githubResult) {
      for (const fr of githubResult.fileResults) {
        const ext = getExt(fr.path);
        const finds = (fr.findings ?? []) as Array<{ lineNumber: number; severity: string; algorithm: string; nistReplacement?: string | null }>;
        zip.file(fr.path, finds.length ? annotate(fr.content ?? "", finds, ext) : (fr.content ?? ""));
      }
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${projectName || githubResult?.repo || "scan"}-quantaxscan-annotated.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [inputMode, tabs, activeTabId, pasteFindings, githubPhase, githubResult, projectName]);

  const samples = getLangSamples(langKey);
  const lk = getLangKey(language);

  return (
    <div className="h-[calc(100dvh-56px)] md:h-[calc(100dvh-64px)] overflow-hidden flex flex-col bg-[#ffffff]">

      {/* ── Upload multi-file scan overlay ──────────────────────────────────── */}
      <AnimatePresence>
        {spaceScanOverlay && (
          <SpaceScanOverlay
            key="upload-overlay"
            current={spaceScanOverlay.current}
            total={spaceScanOverlay.total}
            currentFile={spaceScanOverlay.currentFile}
            projectName={projectName}
          />
        )}
      </AnimatePresence>

      {/* ── GitHub scan overlay ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {githubPhase === "scanning" && (
          <SpaceScanOverlay
            key="github-overlay"
            current={scannedFileCount}
            total={fetchedRepo?.fetchedFiles?.length ?? Math.max(scannedFileCount + 1, 1)}
            currentFile={scanningFileName}
            projectName={fetchedRepo?.repo ?? githubUrl}
          />
        )}
      </AnimatePresence>

      {/* ── Top toolbar ─────────────────────────────────────────────────────── */}
      <div className="h-10 bg-[#f7f8fa] border-b border-[#e5e7eb] flex items-center px-3 gap-2 shrink-0">
        <div className="flex items-center bg-[#f1f3f7] rounded p-0.5 gap-0.5 border border-[#e5e7eb]">
          {(["paste","github"] as const).map(m => (
            <button key={m} onClick={() => setInputMode(m)}
              className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                inputMode === m ? "bg-[#4f46e5]/15 text-[#4f46e5] border border-[#4f46e5]/30" : "text-[#6b7280] hover:text-[#0a0e1a]")}>
              {m === "paste" ? <><Upload className="h-3 w-3" /> Upload Code</> : <><Github className="h-3 w-3" /> GitHub URL</>}
            </button>
          ))}
        </div>

        {/* Hidden file input — id used by <label htmlFor> in the drop zone */}
        <input id="file-upload-input" ref={fileInputRef} type="file" className="hidden"
          accept=".py,.js,.ts,.tsx,.jsx,.go,.java,.cs,.cpp,.c,.rb,.php,.rs,.kt,.swift,.sh,.zip"
          multiple onChange={handleFileInputChange} />

        {inputMode === "paste" ? (
          <>
            <div className="w-px h-5 bg-[#eef0fe] mx-1" />
            {/* Upload button — always visible */}
            <button onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 h-7 px-2.5 bg-[#4f46e5]/10 border border-[#4f46e5]/30 rounded text-[11px] text-[#4f46e5] hover:bg-[#4f46e5]/20 transition-colors font-mono">
              <FolderOpen className="h-3 w-3" /> Choose File
            </button>
            {hasCustomFile && (
              <>
                <input value={projectName} onChange={e => setProjectName(e.target.value)}
                  className="h-7 w-32 bg-[#ffffff] border border-[#4f46e5]/15 rounded px-2 text-[12px] text-[#0a0e1a] focus:outline-none focus:border-[#4f46e5]/40 font-mono" placeholder="project-name" />
                <select value={language} onChange={e => handleLanguageChange(e.target.value)}
                  className="h-7 bg-[#f1f3f7] border border-[#e5e7eb] rounded px-2 text-[12px] text-[#0a0e1a] focus:outline-none cursor-pointer">
                  {["java","python","go","javascript","typescript","rust","csharp","cpp","swift"].map(l => (
                    <option key={l} value={l}>{l === "csharp" ? "C#" : l === "cpp" ? "C++" : l.charAt(0).toUpperCase() + l.slice(1)}</option>
                  ))}
                </select>
              </>
            )}
            <div className="flex-1" />
            {hasCustomFile && (
              <select value={mode} onChange={e => setMode(e.target.value as CreateScanBodyMode)}
                className="h-7 bg-[#f1f3f7] border border-[#e5e7eb] rounded px-2 text-[12px] text-[#0a0e1a] focus:outline-none cursor-pointer mr-2">
                <option value="scan-only">Scan Only</option>
                <option value="interactive">Interactive</option>
                <option value="proactive">Proactive</option>
              </select>
            )}
            <button onClick={startScan} disabled={scanState === "scanning" || !hasCustomFile}
              className={cn(
                "flex items-center gap-1.5 h-7 px-3 rounded border transition-colors",
                hasCustomFile
                  ? "border-[#4f46e5] bg-[#4f46e5]/8 text-[#4f46e5] hover:bg-[#4f46e5]/15 shadow-sm"
                  : "border-[#e5e7eb] bg-transparent text-[#9aa3b2] cursor-not-allowed"
              )}>
              {scanState === "scanning"
                ? <><span className="h-3 w-3 border-2 border-[#4f46e5] border-t-transparent rounded-full animate-spin" /> Scanning…</>
                : <><Play className="h-3 w-3" /> Run Scan</>}
            </button>
            {scanState === "complete" && pasteFindings.length > 0 && (
              <button onClick={() => void downloadAnnotatedZip()}
                title="Download all files as ZIP with findings embedded as comments"
                className="flex items-center gap-1 h-7 px-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded text-[11px] text-emerald-600 hover:bg-emerald-500/20 transition-colors font-mono ml-1">
                <Download className="h-3 w-3" /> Download ZIP
              </button>
            )}
          </>
        ) : (
          <>
            <div className="w-px h-5 bg-[#eef0fe] mx-1" />
            <Github className="h-3.5 w-3.5 text-[#6b7280] shrink-0" />
            <input value={githubUrl} onChange={e => setGithubUrl(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (githubPhase === "idle" || githubPhase === "error")) fetchRepo(); }}
              placeholder="https://github.com/owner/repo"
              className="flex-1 h-7 bg-[#ffffff] border border-[#4f46e5]/15 rounded px-2 text-[12px] text-[#0a0e1a] focus:outline-none focus:border-[#4f46e5]/40 font-mono" />

            {/* Quick-pick repos — only in idle/error */}
            {(githubPhase === "idle" || githubPhase === "error") && (
              <div className="flex gap-1.5 ml-2 shrink-0">
                {QUICK_REPOS.map(r => (
                  <button key={r.url} onClick={() => selectQuickRepo(r.url)}
                    className="h-7 px-2 bg-[#ffffff] border border-[#4f46e5]/12 hover:border-[#4f46e5]/40 rounded text-[10px] text-[#6b7280] hover:text-[#4f46e5] transition-colors font-mono">
                    {r.label.split("/")[1]}
                  </button>
                ))}
              </div>
            )}

            {/* After scan: Share + Download report + Download ZIP */}
            {githubPhase === "scanned" && (
              <div className="flex items-center gap-1.5 ml-2">
                <button onClick={shareReport} disabled={sharing}
                  className="flex items-center gap-1 h-7 px-2.5 bg-[#4f46e5]/12 border border-[#4f46e5]/30 rounded text-[11px] text-[#4f46e5] hover:bg-[#4f46e5]/20 transition-colors disabled:opacity-50">
                  {sharing ? <span className="h-3 w-3 border-2 border-[#4f46e5]/50 border-t-[#4f46e5] rounded-full animate-spin" />
                    : shareCopied ? <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    : <ExternalLink className="h-3 w-3" />}
                  {shareCopied ? "Copied!" : "Share"}
                </button>
                <button onClick={downloadReport}
                  className="flex items-center gap-1 h-7 px-2 bg-[#f1f3f7] border border-[#e5e7eb] rounded text-[11px] text-[#475569] hover:text-[#0a0e1a] transition-colors">
                  <Download className="h-3 w-3" /> Report
                </button>
                <button onClick={() => void downloadAnnotatedZip()}
                  title="Download all scanned files as ZIP with findings embedded as comments"
                  className="flex items-center gap-1 h-7 px-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded text-[11px] text-emerald-600 hover:bg-emerald-500/20 transition-colors font-mono">
                  <Download className="h-3 w-3" /> ZIP
                </button>
              </div>
            )}

            {/* After fetched/scanned: Re-fetch */}
            {(githubPhase === "fetched" || githubPhase === "scanned") && (
              <button onClick={fetchRepo} title="Re-fetch repository"
                className="flex items-center gap-1 h-7 px-2 bg-[#f1f3f7] border border-[#e5e7eb] rounded text-[11px] text-[#6b7280] hover:text-[#0a0e1a] transition-colors ml-2">
                <RefreshCw className="h-3 w-3" />
              </button>
            )}

            {/* FETCH REPO button — idle / error */}
            {(githubPhase === "idle" || githubPhase === "error") && (
              <button onClick={fetchRepo}
                className="flex items-center gap-1.5 h-7 px-3 rounded border border-[#4f46e5]/50 bg-transparent text-[#4f46e5]/80 text-[12px] font-mono transition-colors hover:bg-[#4f46e5]/10 hover:border-[#4f46e5] ml-2">
                <Download className="h-3 w-3" /> Fetch Repo
              </button>
            )}

            {/* FETCHING spinner */}
            {githubPhase === "fetching" && (
              <button disabled
                className="flex items-center gap-1.5 h-7 px-3 rounded border border-[#4f46e5]/30 bg-transparent text-[#4f46e5]/50 text-[12px] font-mono ml-2">
                <span className="h-3 w-3 border-2 border-[#4f46e5]/50 border-t-transparent rounded-full animate-spin" /> Fetching…
              </button>
            )}

            {/* RUN SCAN — highlighted when fetched */}
            {githubPhase === "fetched" && (
              <button onClick={runGithubScan}
                className="flex items-center gap-1.5 h-7 px-3 rounded border border-[#4f46e5] bg-[#4f46e5]/12 text-[#4f46e5] text-[12px] font-medium font-semibold transition-colors hover:bg-[#4f46e5]/20 ml-2 shadow-sm">
                <Play className="h-3 w-3" /> Run Scan
              </button>
            )}

            {/* SCANNING spinner */}
            {githubPhase === "scanning" && (
              <button disabled
                className="flex items-center gap-1.5 h-7 px-3 rounded border border-[#4f46e5] bg-transparent text-[#4f46e5] text-[12px] font-mono ml-2">
                <span className="h-3 w-3 border-2 border-[#4f46e5] border-t-transparent rounded-full animate-spin" /> Scanning…
              </button>
            )}

            {/* RE-SCAN — after scanned */}
            {githubPhase === "scanned" && (
              <button onClick={runGithubScan}
                className="flex items-center gap-1.5 h-7 px-3 rounded border border-[#4f46e5] bg-transparent text-[#4f46e5] text-[12px] font-mono transition-colors hover:bg-[#4f46e5]/10 ml-2">
                <RefreshCw className="h-3 w-3" /> Re-scan
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Multi-scan project summary bar ──────────────────────────────────── */}
      {Object.keys(tabFindings).length > 0 && scanState === "complete" && (
        <SummaryBar tabFindings={tabFindings} tabs={tabs} setActiveTabId={setActiveTabId} />
      )}

      {/* ── IDE body ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* Activity bar */}
        <ActivityBar explorerOpen={explorerOpen} chatOpen={chatOpen}
          onExplorer={() => setExplorerOpen(v => !v)} onChat={() => setChatOpen(v => !v)} />

        {/* Explorer */}
        <AnimatePresence initial={false}>
          {explorerOpen && (
            <motion.div key="explorer" initial={{ width: 0 }} animate={{ width: explorerWidth }} exit={{ width: 0 }}
              transition={{ duration: 0.18, ease: "easeInOut" }}
              className="border-r border-[#e5e7eb] bg-[#f7f8fa] flex flex-col overflow-hidden shrink-0 relative">
              <div className="h-8 flex items-center justify-between px-3 shrink-0">
                <span className="text-[10px] font-semibold tracking-widest text-[#6b7280] uppercase">Explorer</span>
                <button className="p-0.5 text-[#9aa3b2] hover:text-[#334155]"><MoreHorizontal className="h-3.5 w-3.5" /></button>
              </div>
              <ScrollArea className="flex-1">
                {inputMode === "paste" ? (
                  <div className="pb-4">
                    {/* Root folder */}
                    <button onClick={() => toggleCollapse("root")}
                      className="flex items-center gap-1 w-full px-2 py-1 text-[11px] font-semibold text-[#334155] uppercase tracking-wider hover:bg-[#f1f3f7]">
                      {collapsed.has("root") ? <ChevronRight className="h-3 w-3 text-[#9aa3b2]" /> : <ChevronDown className="h-3 w-3 text-[#9aa3b2]" />}
                      <span className="truncate flex-1 text-left">{projectName}</span>
                      {hasCustomFile && (
                        <span className="text-[9px] text-[#9aa3b2] font-mono ml-1 shrink-0">{tabs.length}</span>
                      )}
                    </button>
                    {!collapsed.has("root") && (
                      <>
                        {hasCustomFile ? (
                          /* ── Uploaded / ZIP file tree ── */
                          buildUploadTree(tabs).map(node => (
                            <UploadedTreeNode
                              key={node.type === "file" ? node.key : node.folderKey}
                              node={node} depth={0} activeTabId={activeTabId}
                              collapsed={collapsed} onToggle={toggleCollapse}
                              onSelect={setActiveTabId}
                              findings={pasteFindings} allTabFindings={tabFindings} scanState={scanState}
                            />
                          ))
                        ) : (
                          /* ── Demo sample files ── */
                          <>
                            {/* src/ folder */}
                            <button onClick={() => setSrcOpen(v => !v)}
                              className="flex items-center gap-1.5 w-full py-[3px] text-[12px] text-[#475569] hover:bg-[#f1f3f7] hover:text-[#0a0e1a] font-mono"
                              style={{ paddingLeft: 16 }}>
                              {srcOpen ? <ChevronDown className="h-3 w-3 text-[#9aa3b2] shrink-0" /> : <ChevronRight className="h-3 w-3 text-[#9aa3b2] shrink-0" />}
                              <FolderSvg open={srcOpen} />
                              <span>src</span>
                            </button>
                            {srcOpen && samples.map(sf => {
                              const filePath = `src/${sf.name}`;
                              const isActive = activeTab?.path === filePath;
                              const fileExt  = getExt(sf.name);
                              const fileLk   = getLangKey("", sf.name);
                              const hasFind  = isActive && scanState === "complete" && pasteFindings.length > 0;
                              return (
                                <button key={sf.name}
                                  onClick={() => openFileInTab(sf.name, sf.content, fileLk, filePath, true)}
                                  className={cn(
                                    "flex items-center gap-1.5 w-full py-[3px] text-[12px] font-mono border-l-2 transition-colors",
                                    isActive ? "bg-[#4f46e5]/8 text-[#4f46e5] border-[#4f46e5]" : "text-[#6b7280] hover:text-[#0a0e1a] hover:bg-[#f1f3f7] border-transparent",
                                  )}
                                  style={{ paddingLeft: 28 }}
                                >
                                  <span className="w-3 shrink-0" /><FileIcon ext={fileExt} />
                                  <span className="ml-1 flex-1 text-left truncate">{sf.name}</span>
                                  {hasFind && (
                                    <div className="flex gap-0.5 shrink-0 mr-1">
                                      {pasteFindings.some(f => f.severity === "critical") && <div className="h-1.5 w-1.5 rounded-full bg-red-500" />}
                                      {pasteFindings.some(f => f.severity === "alert")    && <div className="h-1.5 w-1.5 rounded-full bg-yellow-500" />}
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                            {/* Root files */}
                            {[{ name: ".gitignore", content: GITIGNORE }, { name: "README.md", content: README_MD }, { name: "package.json", content: PKG_JSON }].map(rf => {
                              const ext = getExt(rf.name);
                              const flk = getLangKey("", rf.name);
                              return (
                                <button key={rf.name}
                                  onClick={() => openFileInTab(rf.name, rf.content, flk, rf.name, true)}
                                  className={cn(
                                    "flex items-center gap-1.5 w-full py-[3px] text-[12px] font-mono text-[#6b7280] hover:text-[#334155] hover:bg-[#f1f3f7] transition-colors",
                                  )}
                                  style={{ paddingLeft: 20 }}
                                >
                                  <span className="w-3 shrink-0" /><FileIcon ext={ext} />
                                  <span className="ml-1">{rf.name}</span>
                                </button>
                              );
                            })}
                          </>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  /* GitHub mode — multi-phase tree */
                  githubPhase === "idle" || githubPhase === "error" ? (
                    <div className="px-3 py-6">
                      {rateLimitHit ? (
                        /* ── Rate-limit help panel ── */
                        <div className="space-y-3">
                          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-yellow-500/8 border border-yellow-500/20">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                              <p className="text-[11px] text-amber-700 font-semibold mb-1">GitHub API rate limit reached</p>
                              <p className="text-[10px] text-amber-600/70 leading-relaxed">
                                The GitHub API quota for this server's IP is temporarily exhausted.
                              </p>
                              {rateLimitResetAt && (
                                <p className="text-[10px] text-amber-600/90 font-mono mt-1.5">
                                  Resets at {new Date(rateLimitResetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                  {" "}({Math.max(1, Math.ceil((rateLimitResetAt - Date.now()) / 60000))} min)
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="p-2.5 rounded-lg bg-[#4f46e5]/6 border border-[#4f46e5]/15 space-y-2">
                            <p className="text-[10px] text-[#4f46e5] font-semibold">Alternative: upload a .zip archive</p>
                            <p className="text-[10px] text-[#475569] leading-relaxed">
                              Download a ZIP of the repo from GitHub and use <span className="text-[#0a0e1a]">Upload Code</span> — no API limits apply.
                            </p>
                          </div>
                          <div className="p-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/15 space-y-2">
                            <p className="text-[10px] text-emerald-600 font-semibold">Or add a GitHub token (5000 req/hr)</p>
                            <ol className="text-[10px] text-[#475569] space-y-1.5 leading-relaxed list-none">
                              <li className="flex gap-1.5"><span className="text-emerald-600 shrink-0 font-mono">1.</span>Go to <span className="text-emerald-600">github.com → Settings</span></li>
                              <li className="flex gap-1.5"><span className="text-emerald-600 shrink-0 font-mono">2.</span>Developer settings → Personal access tokens → Classic</li>
                              <li className="flex gap-1.5"><span className="text-emerald-600 shrink-0 font-mono">3.</span>Generate new token — no scopes needed for public repos</li>
                              <li className="flex gap-1.5"><span className="text-emerald-600 shrink-0 font-mono">4.</span>Set <code className="bg-[#f1f3f7] px-1 rounded text-[9px] font-mono text-emerald-600">GITHUB_TOKEN</code> as an environment variable</li>
                            </ol>
                            <a href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer"
                              className="flex items-center gap-1 text-[10px] text-emerald-600 hover:underline mt-1">
                              <ExternalLink className="h-3 w-3" /> Open GitHub token page
                            </a>
                          </div>
                          <div className="space-y-1 pt-1">
                            <p className="text-[10px] text-[#9aa3b2] uppercase tracking-wider mb-1">Quick repos to try later</p>
                            {QUICK_REPOS.map(r => (
                              <button key={r.url} onClick={() => selectQuickRepo(r.url)}
                                className="w-full text-left px-2 py-1.5 rounded text-[11px] text-[#6b7280] hover:text-[#334155] hover:bg-[#f1f3f7] font-mono transition-colors">
                                {r.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        /* ── Normal idle / error state ── */
                        <div className="text-center">
                          <Github className="h-8 w-8 text-[#9aa3b2] mx-auto mb-3" />
                          <p className="text-[11px] text-[#6b7280]">
                            {githubPhase === "error"
                              ? (githubError?.long ?? GITHUB_BAD_URL_ERROR.long)
                              : "Enter a GitHub URL above to fetch a repository."}
                          </p>
                          <div className="mt-4 space-y-1">
                            {QUICK_REPOS.map(r => (
                              <button key={r.url} onClick={() => selectQuickRepo(r.url)}
                                className="w-full text-left px-2 py-1.5 rounded text-[11px] text-[#6b7280] hover:text-[#334155] hover:bg-[#f1f3f7] font-mono transition-colors">
                                {r.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : githubPhase === "fetching" ? (
                    <div className="px-3 py-8 text-center">
                      <div className="h-6 w-6 border-2 border-[#4f46e5] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                      <p className="text-[11px] text-[#6b7280]">{fetchProgress}</p>
                    </div>
                  ) : githubPhase === "scanning" ? (
                    /* While scanning, keep showing the tree with a scanning overlay badge */
                    <div className="pb-4">
                      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-[#334155] uppercase tracking-wider">
                        <ChevronDown className="h-3 w-3 text-[#9aa3b2]" />
                        <span>{fetchedRepo?.repo}</span>
                        <span className="ml-auto text-[9px] text-[#4f46e5] font-mono flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#4f46e5] animate-pulse" /> scanning
                        </span>
                      </div>
                      {fullRepoTree.map(node => (
                        <FullTreeItem key={node.path} node={node} depth={0}
                          selectedPath={selectedFullPath}
                          onSelect={n => { if (n.content) setSelectedFullPath(n.path); }}
                          collapsed={collapsed} onToggle={toggleCollapse} phase={githubPhase} />
                      ))}
                    </div>
                  ) : (fetchedRepo && (githubPhase === "fetched" || githubPhase === "scanned")) ? (
                    <div className="pb-4">
                      {/* Repo header */}
                      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-[#334155] uppercase tracking-wider">
                        <ChevronDown className="h-3 w-3 text-[#9aa3b2]" />
                        <span>{fetchedRepo.repo}</span>
                        {githubPhase === "fetched" && (
                          <span className="ml-auto text-[9px] text-emerald-600 font-mono">{fetchedRepo.fetchedFiles.length} files ready</span>
                        )}
                        {githubPhase === "scanned" && githubResult && (
                          <span className="ml-auto text-[9px] text-red-600 font-mono">{githubResult.criticalCount}C {githubResult.alertCount}A</span>
                        )}
                      </div>
                      {/* CTA banner when fetched but not yet scanned */}
                      {githubPhase === "fetched" && (
                        <div className="mx-2 mb-2 px-2 py-1.5 rounded bg-[#4f46e5]/8 border border-[#4f46e5]/20 flex items-center gap-2">
                          <Play className="h-3 w-3 text-[#4f46e5] shrink-0" />
                          <span className="text-[10px] text-[#4f46e5]">Click <strong>Run Scan</strong> to analyse</span>
                        </div>
                      )}
                      {fullRepoTree.map(node => (
                        <FullTreeItem key={node.path} node={node} depth={0}
                          selectedPath={selectedFullPath}
                          onSelect={n => {
                            if (n.type === "file") {
                              setSelectedFullPath(n.path);
                              // In scanned mode, also update selectedFile for findings
                              if (githubPhase === "scanned" && githubResult) {
                                const sf = githubResult.fileResults.find(f => f.path === n.path);
                                if (sf) setSelectedFile(sf);
                              }
                            }
                          }}
                          collapsed={collapsed} onToggle={toggleCollapse} phase={githubPhase} />
                      ))}
                    </div>
                  ) : null
                )}
              </ScrollArea>
              <div onMouseDown={onExplorerResizeMD}
                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#4f46e5]/30 transition-colors z-20" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Editor + bottom panel ──────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {inputMode === "paste" ? (
            !hasCustomFile ? (
              /* ── Upload drop zone — <label> makes entire area clickable natively ── */
              <label
                htmlFor={zipExtracting ? undefined : "file-upload-input"}
                className="flex-1 flex items-center justify-center bg-[#ffffff] select-none"
                style={{ cursor: zipExtracting ? "default" : "pointer" }}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={e => { e.stopPropagation(); handleEditorDrop(e); }}
              >
                {zipExtracting && zipStats ? (
                  /* ── Extraction progress state ── */
                  <div className="border-2 border-dashed border-[#4f46e5]/40 rounded-2xl px-16 py-14 flex flex-col items-center gap-5 mx-8 text-center min-w-[380px]">
                    <div className="h-16 w-16 rounded-2xl bg-[#4f46e5]/10 border border-[#4f46e5]/30 flex items-center justify-center">
                      <span className="h-7 w-7 border-[3px] border-[#4f46e5] border-t-transparent rounded-full animate-spin block" />
                    </div>
                    <div>
                      <p className="text-[15px] text-[#0a0e1a] font-semibold mb-1">Extracting {zipStats.name}</p>
                      <p className="text-[12px] text-[#6b7280]">
                        {zipStats.total === 0 ? "Reading zip…" : `${zipStats.loaded} / ${zipStats.total} files`}
                      </p>
                    </div>
                    {zipStats.total > 0 && (
                      <div className="w-full max-w-xs">
                        <div className="h-1.5 bg-[#eef0fe] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[#4f46e5] rounded-full transition-all duration-200"
                            style={{ width: `${Math.round((zipStats.loaded / zipStats.total) * 100)}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-[#9aa3b2] mt-1.5 font-mono text-right">
                          {Math.round((zipStats.loaded / zipStats.total) * 100)}%
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* ── Idle drop zone ── */
                  <div className="border-2 border-dashed border-[#4f46e5]/25 hover:border-[#4f46e5]/55 transition-colors rounded-2xl px-16 py-14 flex flex-col items-center gap-5 mx-8 text-center">
                    <div className="h-16 w-16 rounded-2xl bg-[#4f46e5]/8 border border-[#4f46e5]/20 flex items-center justify-center">
                      <Upload className="h-8 w-8 text-[#4f46e5]/60" />
                    </div>
                    <div>
                      <p className="text-[15px] text-[#0a0e1a] font-semibold mb-1">Click to choose a file, or drag &amp; drop</p>
                      <p className="text-[12px] text-[#6b7280]">Supports code files and .zip archives</p>
                    </div>
                    {/* File type badges */}
                    <div className="flex flex-col items-center gap-2">
                      <div className="flex flex-wrap justify-center gap-1.5 max-w-sm">
                        {[".py",".js",".ts",".java",".go",".rs",".cpp",".c",".rb",".php",".kt",".swift"].map(ext => (
                          <span key={ext} className="px-2 py-0.5 bg-[#f1f3f7] border border-[#e5e7eb] rounded text-[10px] text-[#6b7280] font-mono">{ext}</span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="h-px w-12 bg-[#eef0fe]" />
                        <span className="px-2.5 py-0.5 bg-[#4f46e5]/10 border border-[#4f46e5]/30 rounded text-[10px] text-[#4f46e5] font-mono font-semibold">.zip</span>
                        <span className="text-[10px] text-[#9aa3b2]">GitHub download &amp; scan</span>
                        <div className="h-px w-12 bg-[#eef0fe]" />
                      </div>
                    </div>
                    <span className="flex items-center gap-2 px-6 py-2.5 bg-[#4f46e5]/15 border border-[#4f46e5]/50 rounded-lg text-[13px] text-[#4f46e5] font-semibold pointer-events-none">
                      <FolderOpen className="h-4 w-4" /> Browse Files
                    </span>
                  </div>
                )}
              </label>
            ) : (
              /* ── Code editor (file loaded) ── */
              <>
                <TabBar tabs={tabs} activeId={activeTabId} onSelect={setActiveTabId}
                  onClose={id => {
                    const remaining = tabs.filter(t => t.id !== id);
                    setTabs(remaining);
                    if (activeTabId === id) setActiveTabId(remaining[remaining.length - 1]?.id ?? "");
                    if (remaining.length === 0) setHasCustomFile(false);
                  }}
                  onNew={() => {
                    const t = makeBlankTab();
                    setTabs(prev => [...prev, t]);
                    setActiveTabId(t.id);
                  }}
                />
                <CodeEditorView
                  content={activeTab?.content ?? ""}
                  langKey={activeTab?.langKey ?? lk}
                  editable={scanState === "idle"}
                  findings={scanState === "complete" ? pasteFindings : []}
                  currentScanLine={currentLine}
                  scanState={scanState}
                  onChange={v => setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, content: v, dirty: true } : t))}
                  onDrop={handleEditorDrop}
                />
              </>
            )
          ) : (
            /* GitHub mode editor area — switches on phase */
            githubPhase === "fetched" && previewFile ? (
              /* PHASE: fetched — show file preview, no findings */
              <>
                <div className="flex items-end h-9 bg-[#f7f8fa] border-b border-[#e5e7eb] overflow-x-auto shrink-0">
                  {fetchedRepo?.fetchedFiles.slice(0, 8).map(f => (
                    <button key={f.path} onClick={() => setSelectedFullPath(f.path)}
                      className={cn(
                        "flex items-center gap-1.5 h-9 px-3 text-[12px] font-mono border-r border-[#e5e7eb] shrink-0 transition-colors",
                        f.path === selectedFullPath
                          ? "bg-[#ffffff] text-[#4f46e5] border-t-2 border-t-[#4f46e5]"
                          : "bg-[#f1f3f7] text-[#6b7280] hover:text-[#0a0e1a]",
                      )}>
                      <FileIcon ext={getExt(f.path)} />
                      <span>{f.path.split("/").pop()}</span>
                    </button>
                  ))}
                </div>
                <CodeEditorView
                  content={previewFile.content}
                  langKey={getLangKey(previewFile.language, previewFile.path)}
                  editable={false}
                  findings={[]}
                  currentScanLine={-1} scanState="idle"
                />
              </>
            ) : githubPhase === "scanning" ? (
              /* PHASE: scanning — animated per-file progress list */
              <div className="flex-1 flex flex-col overflow-hidden bg-[#ffffff]">
                {/* Progress header */}
                <div className="shrink-0 px-5 py-3 border-b border-[#e5e7eb] bg-[#f7f8fa] flex items-center gap-3">
                  <span className="h-4 w-4 border-2 border-[#4f46e5] border-t-transparent rounded-full animate-spin shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between text-[10px] font-mono mb-1">
                      <span className="text-[#4f46e5]">Scanning {fetchedRepo?.repo ?? "repo"}…</span>
                      <span className="text-[#6b7280]">{scannedFileCount}/{fetchedRepo?.fetchedFiles.length ?? 0} files</span>
                    </div>
                    <div className="h-1 bg-[#eef0fe] rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-[#4f46e5] to-[#4338ca] rounded-full transition-all duration-200"
                        style={{ width: `${fetchedRepo?.fetchedFiles.length ? Math.round((scannedFileCount / fetchedRepo.fetchedFiles.length) * 100) : 0}%` }} />
                    </div>
                  </div>
                </div>
                {/* Per-file list */}
                <div className="flex-1 overflow-y-auto px-5 py-3 space-y-0.5">
                  {fetchedRepo?.fetchedFiles.map((f, i) => {
                    const done   = i < scannedFileCount;
                    const active = f.path === scanningFileName;
                    const fname  = f.path.split("/").pop() ?? f.path;
                    const dir    = f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") + "/" : "";
                    return (
                      <div key={f.path} className={cn(
                        "flex items-center gap-2.5 px-3 py-1.5 rounded text-[12px] font-mono transition-all duration-150",
                        active ? "bg-[#4f46e5]/10 text-[#4f46e5]"
                          : done  ? "text-[#6b7280]"
                          : "text-[#9aa3b2]"
                      )}>
                        {done
                          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                          : active
                            ? <span className="h-3.5 w-3.5 border-2 border-[#4f46e5] border-t-transparent rounded-full animate-spin shrink-0" />
                            : <div className="h-3.5 w-3.5 rounded-full border border-[#e5e7eb] shrink-0" />}
                        <span className="text-[#9aa3b2] shrink-0 hidden sm:inline">{dir}</span>
                        <span className="truncate">{fname}</span>
                        {done && <span className="ml-auto text-[10px] text-[#9aa3b2] shrink-0">{f.lines}L</span>}
                        {active && <span className="ml-auto text-[10px] text-[#4f46e5]/70 shrink-0 animate-pulse">analysing…</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : githubPhase === "scanned" && (selectedFile ?? githubResult) ? (
              /* PHASE: scanned — summary bar + file with findings */
              <>
                {/* Scan summary strip */}
                {githubResult && (
                  <div className="shrink-0 px-4 py-2 bg-[#f7f8fa] border-b border-[#e5e7eb] flex items-center gap-4 flex-wrap">
                    <div className={cn(
                      "flex items-center gap-1.5 px-2 py-0.5 rounded font-mono text-[11px] font-bold",
                      githubResult.riskScore >= 70 ? "bg-red-500/15 text-red-600 border border-red-500/25"
                        : githubResult.riskScore >= 40 ? "bg-yellow-500/15 text-amber-600 border border-yellow-500/25"
                        : "bg-emerald-500/15 text-emerald-600 border border-emerald-500/25"
                    )}>
                      <Shield className="h-3 w-3" />
                      Risk {githubResult.riskScore}/100
                    </div>
                    <span className="text-[11px] text-red-600 font-mono">{githubResult.criticalCount} critical</span>
                    <span className="text-[11px] text-amber-600 font-mono">{githubResult.alertCount} alerts</span>
                    <span className="text-[11px] text-emerald-600 font-mono">{githubResult.cleanCount} clean</span>
                    <span className="text-[11px] text-[#9aa3b2] font-mono">{githubResult.totalFiles} files · {githubResult.totalLines.toLocaleString()} lines</span>
                    <span className="text-[10px] text-[#9aa3b2] font-mono ml-auto hidden sm:block">↓ click a file in the explorer to view findings</span>
                  </div>
                )}
                {/* File tabs */}
                <div className="flex items-end h-9 bg-[#f7f8fa] border-b border-[#e5e7eb] overflow-x-auto shrink-0">
                  {(githubResult?.fileResults ?? []).slice(0, 8).map(f => (
                    <button key={f.path} onClick={() => { setSelectedFile(f); setSelectedFullPath(f.path); }}
                      className={cn(
                        "flex items-center gap-1.5 h-9 px-3 text-[12px] font-mono border-r border-[#e5e7eb] shrink-0 transition-colors",
                        f.path === (selectedFile?.path ?? "")
                          ? "bg-[#ffffff] text-[#4f46e5] border-t-2 border-t-[#4f46e5]"
                          : "bg-[#f1f3f7] text-[#6b7280] hover:text-[#0a0e1a]",
                      )}>
                      <FileIcon ext={getExt(f.path)} />
                      <span>{f.path.split("/").pop()}</span>
                      {f.criticalCount > 0 && <span className="text-[9px] text-red-600 ml-1">{f.criticalCount}C</span>}
                    </button>
                  ))}
                </div>
                <CodeEditorView
                  content={selectedFile?.content ?? ""}
                  langKey={getLangKey(selectedFile?.language ?? "", selectedFile?.path ?? "")}
                  editable={false}
                  findings={selectedFileFindings}
                  currentScanLine={-1} scanState="complete"
                />
              </>
            ) : (
              /* idle / fetching / error / no selection */
              <div className="flex-1 flex items-center justify-center text-[#9aa3b2] flex-col gap-3">
                <Shield className="h-12 w-12 opacity-30" />
                <span className="text-sm font-mono">
                  {githubPhase === "fetching" ? fetchProgress
                    : githubPhase === "error" ? (githubError?.short ?? GITHUB_BAD_URL_ERROR.short)
                    : "Fetch a GitHub repo to browse its files."}
                </span>
              </div>
            )
          )}

          <BottomPanel open={bottomOpen} onToggle={() => setBottomOpen(v => !v)}
            activeTab={bottomTab} onTabChange={setBottomTab}
            findings={inputMode === "paste" ? (scanState === "complete" ? pasteFindings : []) : (githubPhase === "scanned" ? allGithubFindings : selectedFileFindings)}
            outputLogs={outputLogs} scanState={scanState}
            height={bottomHeight} onResizeMD={onBottomResizeMD}
            onAskAI={handleAskAI} />
        </div>

        {/* Chat */}
        <ChatPanel open={chatOpen} onToggle={() => setChatOpen(v => !v)}
          findings={inputMode === "paste" ? (scanState === "complete" ? pasteFindings : []) : (githubPhase === "scanned" ? allGithubFindings : selectedFileFindings)}
          scanState={scanState}
          width={chatWidth} onResizeMD={onChatResizeMD}
          triggerMsg={chatTrigger} onTriggerConsumed={() => setChatTrigger(null)} />
      </div>

      {/* ── Status bar ──────────────────────────────────────────────────────── */}
      <div className="h-6 bg-[#f1f3f7] border-t border-[#4f46e5]/12 flex items-center px-3 gap-4 shrink-0">
        <div className="flex items-center gap-1.5 text-[10px] text-[#4f46e5]/60 font-mono">
          <Files className="h-3 w-3" /> {activeTab?.label ?? "untitled"}
        </div>
        {scanState === "complete" && pasteFindings.length > 0 && (
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className="text-red-600 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{pasteFindings.filter(f => f.severity === "critical").length} critical</span>
            <span className="text-amber-700 flex items-center gap-1"><Zap className="h-3 w-3" />{pasteFindings.filter(f => f.severity === "alert").length} alerts</span>
          </div>
        )}
        {githubPhase === "fetched" && fetchedRepo && (
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className="text-emerald-600">{fetchedRepo.repo}</span>
            <span className="text-[#6b7280]">{fetchedRepo.fetchedFiles.length} files fetched · {fetchedRepo.totalNodes} total</span>
            {fetchedRepo.truncated && <span className="text-amber-600">truncated</span>}
          </div>
        )}
        {githubPhase === "scanned" && githubResult && (
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className="text-red-600">{githubResult.criticalCount} critical</span>
            <span className="text-amber-700">{githubResult.alertCount} alerts</span>
            <span className="text-[#6b7280]">{githubResult.totalFiles} files · {githubResult.totalLines.toLocaleString()} lines</span>
          </div>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-[10px] text-[#6b7280] font-mono">
          <span>{LANG_NAMES[langKey] ?? langKey.toUpperCase()}</span>
          <span>UTF-8</span>
          <span>● Local</span>
          <span>QuantaXscan v2</span>
        </div>
      </div>
    </div>
  );
}
