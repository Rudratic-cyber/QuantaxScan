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

function QBitronMark({ size = 32, glow = true, animate: doAnimate = false }: {
  size?: number; glow?: boolean; animate?: boolean;
}) {
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
      style={glow ? { filter: "drop-shadow(0 0 4px rgba(79,142,247,0.8)) drop-shadow(0 0 14px rgba(79,142,247,0.35))" } : undefined}
    >
      <defs>
        <linearGradient id="qb-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f8ef7" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.08" />
        </linearGradient>
        <linearGradient id="qb-stroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f8ef7" />
          <stop offset="100%" stopColor="#7c6af5" />
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
        stroke="rgba(79,142,247,0.2)"
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
            stroke="rgba(79,142,247,0.3)" strokeWidth={s * 0.025} strokeLinecap="round" />
        );
      })}

      {/* Central Q letterform */}
      <text
        x={cx} y={cy + s * 0.105}
        textAnchor="middle"
        fontSize={s * 0.36}
        fontWeight="800"
        fontFamily="'JetBrains Mono', 'SF Mono', monospace"
        fill="#4f8ef7"
        letterSpacing="-1"
      >Q</text>

      {/* Quantum orbit ring */}
      <ellipse cx={cx} cy={cy} rx={r * 0.82} ry={r * 0.28}
        fill="none"
        stroke="rgba(167,139,250,0.35)" strokeWidth={s * 0.022}
        transform={`rotate(-40 ${cx} ${cy})`}
        strokeDasharray={`${s * 0.15} ${s * 0.06}`}
      />

      {/* Corner quantum dots */}
      <circle cx={cx + r * 0.72} cy={cy - r * 0.42} r={s * 0.042} fill="#a78bfa" opacity="0.9" />
      <circle cx={cx - r * 0.65} cy={cy + r * 0.48} r={s * 0.032} fill="#4f8ef7" opacity="0.7" />
      <circle cx={cx + r * 0.1}  cy={cy - r * 0.82} r={s * 0.028} fill="#a78bfa" opacity="0.6" />
    </svg>
  );
}

export function QBitronLogo({
  variant = "full",
  size = "sm",
  glow = true,
  className = "",
  animate = false,
}: {
  variant?: LogoVariant;
  size?: LogoSize;
  glow?: boolean;
  className?: string;
  animate?: boolean;
}) {
  const s = SIZE_MAP[size];

  if (variant === "icon") return <QBitronMark size={s.icon} glow={glow} animate={animate} />;

  if (variant === "wordmark") {
    return (
      <span
        className={`font-mono font-bold tracking-tight ${s.text} ${className}`}
        style={{
          color: "#f1f5f9",
          textShadow: glow ? "0 0 12px rgba(79,142,247,0.4)" : undefined,
          letterSpacing: "-0.02em",
        }}
      >
        Q-<span style={{ color: "#4f8ef7" }}>BITRON</span>
      </span>
    );
  }

  return (
    <div className={`flex items-center ${s.gap} ${className}`}>
      <QBitronMark size={s.icon} glow={glow} animate={animate} />
      <span
        className={`font-mono font-bold tracking-tight ${s.text}`}
        style={{
          color: "#f1f5f9",
          textShadow: glow ? "0 0 10px rgba(79,142,247,0.3)" : undefined,
          letterSpacing: "-0.02em",
        }}
      >
        Q-<span style={{ color: "#4f8ef7" }}>BITRON</span>
      </span>
    </div>
  );
}
