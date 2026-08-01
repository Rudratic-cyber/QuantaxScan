import { motion } from "framer-motion";

export type LogoVariant = "full" | "icon" | "wordmark";
export type LogoSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE_MAP: Record<LogoSize, { icon: number; text: string; gap: string; fontSize: number }> = {
  xs: { icon: 18, text: "text-sm",  gap: "gap-1.5", fontSize: 12 },
  sm: { icon: 28, text: "text-base", gap: "gap-2.5", fontSize: 14 },
  md: { icon: 36, text: "text-xl",  gap: "gap-3", fontSize: 18 },
  lg: { icon: 48, text: "text-2xl", gap: "gap-3.5", fontSize: 22 },
  xl: { icon: 64, text: "text-4xl", gap: "gap-4", fontSize: 30 },
};

function QBitronMark({ size = 32 }: { size?: number; glow?: boolean; animate?: boolean }) {
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const r = s * 0.44;

  const hexPoints = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  }).join(" ");

  const innerHexPoints = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    const ir = r * 0.72;
    return `${cx + ir * Math.cos(a)},${cy + ir * Math.sin(a)}`;
  }).join(" ");

  return (
    <svg
      width={s} height={s}
      viewBox={`0 0 ${s} ${s}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="qb-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f46e5" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#0d9488" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id="qb-stroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="100%" stopColor="#4338ca" />
        </linearGradient>
      </defs>

      {/* Outer hexagon */}
      <polygon
        points={hexPoints}
        fill="url(#qb-grad)"
        stroke="url(#qb-stroke)"
        strokeWidth={s * 0.04}
        strokeLinejoin="round"
      />

      {/* Inner hexagon (faint) */}
      <polygon
        points={innerHexPoints}
        fill="none"
        stroke="rgba(79,70,229,0.18)"
        strokeWidth={s * 0.022}
        strokeLinejoin="round"
      />

      {/* Circuit trace lines radiating from center */}
      {[0, 60, 120, 180, 240, 300].map((deg, i) => {
        const a = (deg * Math.PI) / 180;
        const x1 = cx + r * 0.22 * Math.cos(a);
        const y1 = cy + r * 0.22 * Math.sin(a);
        const x2 = cx + r * 0.6 * Math.cos(a);
        const y2 = cy + r * 0.6 * Math.sin(a);
        return (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke="rgba(79,70,229,0.28)" strokeWidth={s * 0.025} strokeLinecap="round" />
        );
      })}

      {/* Central Q letterform */}
      <text
        x={cx} y={cy + s * 0.105}
        textAnchor="middle"
        fontSize={s * 0.36}
        fontWeight="800"
        fontFamily="'Inter', system-ui, sans-serif"
        fill="#4f46e5"
        letterSpacing="-1"
      >Q</text>

      {/* Quantum orbit ring */}
      <ellipse cx={cx} cy={cy} rx={r * 0.82} ry={r * 0.28}
        fill="none"
        stroke="rgba(13,148,136,0.4)" strokeWidth={s * 0.022}
        transform={`rotate(-40 ${cx} ${cy})`}
        strokeDasharray={`${s * 0.15} ${s * 0.06}`}
      />

      {/* Corner quantum dots */}
      <circle cx={cx + r * 0.72} cy={cy - r * 0.42} r={s * 0.042} fill="#0d9488" opacity="0.9" />
      <circle cx={cx - r * 0.65} cy={cy + r * 0.48} r={s * 0.032} fill="#4f46e5" opacity="0.7" />
      <circle cx={cx + r * 0.1}  cy={cy - r * 0.82} r={s * 0.028} fill="#0d9488" opacity="0.6" />
    </svg>
  );
}

export function QBitronLogo({
  variant = "full",
  size = "sm",
  className = "",
}: {
  variant?: LogoVariant;
  size?: LogoSize;
  glow?: boolean;
  className?: string;
  animate?: boolean;
}) {
  const s = SIZE_MAP[size];

  if (variant === "icon") return <QBitronMark size={s.icon} />;

  if (variant === "wordmark") {
    return (
      <span
        className={`font-bold tracking-tight ${s.text} ${className}`}
        style={{ color: "#0a0e1a", letterSpacing: "-0.02em" }}
      >
        Q-<span style={{ color: "#4f46e5" }}>Vuln</span>
      </span>
    );
  }

  return (
    <div className={`flex items-center ${s.gap} ${className}`}>
      <QBitronMark size={s.icon} />
      <span
        className={`font-bold tracking-tight ${s.text}`}
        style={{ color: "#0a0e1a", letterSpacing: "-0.02em" }}
      >
        Q-<span style={{ color: "#4f46e5" }}>Vuln</span>
      </span>
    </div>
  );
}
