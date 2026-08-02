/**
 * Aceternity UI — Vortex (faithful recreation)
 * Simplex-noise flow field. Particles rendered as glowing dots;
 * the canvas fade creates the trailing stream effect.
 */
import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

// ── 2-D Simplex noise (self-contained, seeded fresh per mount) ────────────────
function makeNoise2D() {
  const perm = new Uint8Array(512);
  const tmp = new Uint8Array(256);
  for (let i = 0; i < 256; i++) tmp[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = tmp[i]; tmp[i] = tmp[j]; tmp[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = tmp[i & 255];

  const G2 = (3 - Math.sqrt(3)) / 6;
  const F2 = (Math.sqrt(3) - 1) / 2;
  const grad2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  const dot = (g: number[], x: number, y: number) => g[0]*x + g[1]*y;

  return (x: number, y: number): number => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x-(i-t), y0 = y-(j-t);
    const i1 = x0>y0?1:0, j1 = x0>y0?0:1;
    const x1 = x0-i1+G2, y1 = y0-j1+G2;
    const x2 = x0-1+2*G2, y2 = y0-1+2*G2;
    const g0 = perm[(i + perm[j & 255]) & 255] % 8;
    const g1 = perm[(i+i1 + perm[(j+j1) & 255]) & 255] % 8;
    const g2 = perm[(i+1 + perm[(j+1) & 255]) & 255] % 8;
    let n = 0;
    let t0 = 0.5 - x0*x0 - y0*y0; if (t0>0) { t0*=t0; n += t0*t0*dot(grad2[g0],x0,y0); }
    let t1 = 0.5 - x1*x1 - y1*y1; if (t1>0) { t1*=t1; n += t1*t1*dot(grad2[g1],x1,y1); }
    let t2 = 0.5 - x2*x2 - y2*y2; if (t2>0) { t2*=t2; n += t2*t2*dot(grad2[g2],x2,y2); }
    return 70 * n;
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface VortexProps {
  children?: React.ReactNode;
  className?: string;
  containerClassName?: string;
  particleCount?: number;
  rangeY?: number;
  baseHue?: number;
  baseSpeed?: number;
  rangeSpeed?: number;
  baseRadius?: number;
  rangeRadius?: number;
  backgroundColor?: string;
}

interface Particle {
  x: number; y: number;
  speed: number;
  radius: number;
  hue: number;
  life: number; maxLife: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

// ── Component ─────────────────────────────────────────────────────────────────
export function Vortex({
  children,
  className,
  containerClassName,
  particleCount = 700,
  rangeY = 100,
  baseHue = 220,
  baseSpeed = 0,
  rangeSpeed = 1.5,
  baseRadius = 1,
  rangeRadius = 2,
  backgroundColor = "#000000",
}: VortexProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef       = useRef<number>(0);
  const tickRef      = useRef(0);
  const noise        = useRef(makeNoise2D());
  const particles    = useRef<Particle[]>([]);

  const NOISE_SCALE = 0.0008;
  const NOISE_SPEED = 0.0003;

  const spawnParticle = useCallback((w: number, h: number): Particle => {
    // Color: blue 190-240, violet 260-290, pink/magenta 300-340
    const bands = [[190,240],[260,290],[300,340]];
    const b = bands[(Math.random()*3)|0];
    return {
      x: rand(0, w),
      y: rand(0, h),
      speed:  baseSpeed + rand(0, rangeSpeed),
      radius: baseRadius + rand(0, rangeRadius * 0.6),
      hue: rand(b[0], b[1]),
      life: 0,
      maxLife: (rand(300, 700))|0,
    };
  }, [baseHue, baseSpeed, rangeSpeed, baseRadius, rangeRadius, rangeY]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width  = container.offsetWidth;
      canvas.height = container.offsetHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    particles.current = Array.from({ length: particleCount }, () => {
      const p = spawnParticle(canvas.width, canvas.height);
      p.life = (rand(0, p.maxLife))|0;
      return p;
    });

    const [br,bg,bb] = hexToRgb(backgroundColor);

    const frame = () => {
      tickRef.current++;
      const tick = tickRef.current;
      const n = noise.current;
      const w = canvas.width, h = canvas.height;

      // Canvas fade — controls trail length (higher alpha = shorter trail)
      ctx.fillStyle = `rgba(${br},${bg},${bb},0.22)`;
      ctx.fillRect(0, 0, w, h);

      for (const p of particles.current) {
        p.life++;
        if (p.life >= p.maxLife) {
          Object.assign(p, spawnParticle(w, h));
          continue;
        }

        // Flow-field angle from simplex noise
        const angle = n(p.x * NOISE_SCALE, p.y * NOISE_SCALE + tick * NOISE_SPEED) * Math.PI * 4;
        p.x += Math.cos(angle) * p.speed;
        p.y += Math.sin(angle) * p.speed;

        // Wrap edges
        if (p.x < -5) p.x = w + 5;
        if (p.x > w+5) p.x = -5;
        if (p.y < -5) p.y = h + 5;
        if (p.y > h+5) p.y = -5;

        const t    = p.life / p.maxLife;
        const fade = t < 0.1 ? t/0.1 : t > 0.85 ? (1-t)/0.15 : 1;
        const alpha = fade;

        // Outer soft glow
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius * 5, 0, Math.PI*2);
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 5);
        grd.addColorStop(0, `hsla(${p.hue},100%,70%,${alpha*0.25})`);
        grd.addColorStop(1, `hsla(${p.hue},100%,70%,0)`);
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.restore();

        // Core bright dot
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI*2);
        ctx.shadowColor = `hsl(${p.hue},100%,80%)`;
        ctx.shadowBlur  = p.radius * 6;
        ctx.fillStyle   = `hsla(${p.hue},90%,85%,${alpha})`;
        ctx.fill();
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    rafRef.current = requestAnimationFrame(frame);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafRef.current);
    };
  }, [backgroundColor, particleCount, spawnParticle]);

  return (
    <div ref={containerRef} className={cn("relative overflow-hidden", containerClassName)}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ backgroundColor }} />
      <div className={cn("relative z-10", className)}>{children}</div>
    </div>
  );
}

function hexToRgb(hex: string): [number,number,number] {
  const h = hex.replace("#","");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
