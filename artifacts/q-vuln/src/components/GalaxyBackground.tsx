import { useEffect, useRef } from "react";

interface Star { x: number; y: number; r: number; a: number; twinkleSpeed: number; drift: number; color: number }
interface Nebula { x: number; y: number; rx: number; ry: number; color: string; a: number; phase: number; rotSpeed: number }
interface Particle { x: number; y: number; vx: number; vy: number; r: number; a: number; color: string; life: number; maxLife: number }
interface QuantumLine { x: number; y: number; angle: number; len: number; speed: number; offset: number; color: string }
interface Meteor { x: number; y: number; vx: number; vy: number; len: number; a: number; life: number; maxLife: number; rtl: boolean }
interface Ripple { x: number; y: number; r: number; maxR: number; a: number; color: string }
interface ConstellationNode { x: number; y: number }
interface Constellation { nodes: ConstellationNode[]; edges: [number, number][]; phase: number }

function rand(min: number, max: number) { return min + Math.random() * (max - min); }
function randInt(min: number, max: number) { return Math.floor(rand(min, max)); }

export function GalaxyBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let w = 0, h = 0;

    const resize = () => {
      w = canvas.width  = canvas.offsetWidth;
      h = canvas.height = canvas.offsetHeight;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // ── Stars ─────────────────────────────────────────────────────────────────
    const stars: Star[] = Array.from({ length: 220 }, () => ({
      x: rand(0, 1), y: rand(0, 1),
      r: rand(0.12, 1.6),
      a: rand(0.1, 0.9),
      twinkleSpeed: rand(0.3, 2.2),
      drift: rand(-0.000035, 0.000035),
      color: Math.random() > 0.72 ? 1 : 0,
    }));

    // ── Nebulae ───────────────────────────────────────────────────────────────
    const nebulas: Nebula[] = [
      { x: 0.12, y: 0.18, rx: 0.34, ry: 0.20, color: "79,142,247",  a: 0.062, phase: 0,   rotSpeed: 0.0004 },
      { x: 0.78, y: 0.12, rx: 0.26, ry: 0.16, color: "167,139,250", a: 0.052, phase: 1.5, rotSpeed: 0.0006 },
      { x: 0.52, y: 0.62, rx: 0.38, ry: 0.22, color: "79,142,247",  a: 0.038, phase: 3.0, rotSpeed: 0.0003 },
      { x: 0.88, y: 0.72, rx: 0.20, ry: 0.14, color: "167,139,250", a: 0.048, phase: 2.0, rotSpeed: 0.0008 },
      { x: 0.28, y: 0.78, rx: 0.28, ry: 0.18, color: "99,121,247",  a: 0.034, phase: 4.5, rotSpeed: 0.0005 },
      { x: 0.5,  y: 0.35, rx: 0.18, ry: 0.12, color: "130,100,255", a: 0.028, phase: 0.8, rotSpeed: 0.0007 },
    ];

    // ── Quantum wave lines ─────────────────────────────────────────────────────
    const qLines: QuantumLine[] = Array.from({ length: 7 }, (_, i) => ({
      x: rand(0, 1), y: rand(0, 1),
      angle: rand(0, Math.PI),
      len: rand(0.1, 0.28),
      speed: rand(0.0002, 0.0007),
      offset: rand(0, Math.PI * 2),
      color: i % 2 === 0 ? "79,142,247" : "167,139,250",
    }));

    // ── Floating particles ─────────────────────────────────────────────────────
    const particles: Particle[] = [];
    function spawnParticle() {
      const edge = Math.random();
      let x: number, y: number;
      if (edge < 0.25)      { x = rand(0, 1); y = 0; }
      else if (edge < 0.5)  { x = 1; y = rand(0, 1); }
      else if (edge < 0.75) { x = rand(0, 1); y = 1; }
      else                   { x = 0; y = rand(0, 1); }
      const speed = rand(0.00015, 0.0007);
      const angle = rand(0, Math.PI * 2);
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: rand(0.6, 2.5),
        a: rand(0.3, 0.85),
        color: Math.random() > 0.5 ? "79,142,247" : "167,139,250",
        life: 0,
        maxLife: rand(180, 700),
      });
    }
    for (let i = 0; i < 14; i++) spawnParticle();

    // ── Meteors (diagonal down-right and RTL grand shooting stars) ────────────
    const meteors: Meteor[] = [];
    function spawnMeteor(rtl = false) {
      if (rtl) {
        // Right-to-left grand shooting star: spawns on right edge, moves left
        const angle = rand(Math.PI * 0.88, Math.PI * 1.12); // ~leftward, slight diagonal
        const speed = rand(0.009, 0.016);
        meteors.push({
          x: rand(1.0, 1.15),
          y: rand(0.05, 0.55),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          len: rand(0.14, 0.22),   // longer tail
          a: 1.0,
          life: 0,
          maxLife: randInt(90, 140),
          rtl: true,
        });
      } else {
        // Standard diagonal meteor (top-left to bottom-right)
        const angle = rand(Math.PI * 0.15, Math.PI * 0.45);
        const speed = rand(0.006, 0.014);
        meteors.push({
          x: rand(-0.1, 1.1),
          y: rand(-0.05, 0.4),
          vx:  Math.cos(angle) * speed,
          vy:  Math.sin(angle) * speed,
          len: rand(0.04, 0.12),
          a: rand(0.6, 1.0),
          life: 0,
          maxLife: randInt(60, 110),
          rtl: false,
        });
      }
    }

    // ── Ripple rings ──────────────────────────────────────────────────────────
    const ripples: Ripple[] = [];
    function spawnRipple() {
      ripples.push({
        x: rand(0.1, 0.9), y: rand(0.1, 0.9),
        r: rand(4, 12), maxR: rand(60, 180),
        a: rand(0.3, 0.55),
        color: Math.random() > 0.5 ? "79,142,247" : "167,139,250",
      });
    }
    for (let i = 0; i < 3; i++) spawnRipple();

    // ── Constellations ────────────────────────────────────────────────────────
    const constellations: Constellation[] = [
      {
        nodes: [
          { x: 0.08, y: 0.10 }, { x: 0.12, y: 0.20 }, { x: 0.18, y: 0.15 },
          { x: 0.14, y: 0.28 }, { x: 0.22, y: 0.22 },
        ],
        edges: [[0,1],[1,2],[1,3],[2,4],[3,4]],
        phase: 0,
      },
      {
        nodes: [
          { x: 0.72, y: 0.55 }, { x: 0.78, y: 0.48 }, { x: 0.84, y: 0.56 },
          { x: 0.80, y: 0.63 }, { x: 0.74, y: 0.68 }, { x: 0.86, y: 0.42 },
        ],
        edges: [[0,1],[1,2],[2,3],[3,4],[4,0],[1,5]],
        phase: 1.8,
      },
      {
        nodes: [
          { x: 0.42, y: 0.82 }, { x: 0.48, y: 0.88 }, { x: 0.55, y: 0.84 },
          { x: 0.52, y: 0.77 }, { x: 0.45, y: 0.92 },
        ],
        edges: [[0,1],[1,2],[2,3],[3,0],[1,4]],
        phase: 3.5,
      },
    ];

    let t = 0;
    let frameCount = 0;
    // RTL shooting star timer: fire every 20-30 seconds (at 60fps ≈ 1200-1800 frames)
    let rtlCooldown = randInt(1200, 1800);

    const draw = () => {
      animId = requestAnimationFrame(draw);
      t += 0.009;
      frameCount++;

      // Particle spawning
      if (frameCount % 80 === 0 && particles.length < 22) spawnParticle();
      // Small diagonal meteors
      if (frameCount % 160 === 0 && Math.random() > 0.35) spawnMeteor(false);
      if (meteors.filter(m => !m.rtl).length === 0 && frameCount % 50 === 0 && Math.random() > 0.7) spawnMeteor(false);
      // RTL grand shooting star cooldown
      rtlCooldown--;
      if (rtlCooldown <= 0) {
        spawnMeteor(true);
        rtlCooldown = randInt(1200, 1800); // reset 20-30s
      }
      // Ripples
      if (frameCount % 200 === 0 && ripples.length < 6) spawnRipple();

      ctx.clearRect(0, 0, w, h);

      // Background void
      ctx.fillStyle = "#050810";
      ctx.fillRect(0, 0, w, h);

      // Deep space center wash
      const centerGrad = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, w * 0.65);
      centerGrad.addColorStop(0, "rgba(15,25,55,0.4)");
      centerGrad.addColorStop(1, "rgba(5,8,16,0)");
      ctx.fillStyle = centerGrad;
      ctx.fillRect(0, 0, w, h);

      // ── Nebulae ────────────────────────────────────────────────────────────
      for (const neb of nebulas) {
        const pulse = Math.sin(t * 0.7 + neb.phase) * 0.014;
        const px = neb.x * w, py = neb.y * h;
        const rx = neb.rx * Math.min(w, h), ry = neb.ry * Math.min(w, h);
        const alpha = Math.max(0, neb.a + pulse);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(t * neb.rotSpeed * 100);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        grad.addColorStop(0, `rgba(${neb.color},${alpha})`);
        grad.addColorStop(0.35, `rgba(${neb.color},${alpha * 0.55})`);
        grad.addColorStop(0.7, `rgba(${neb.color},${alpha * 0.18})`);
        grad.addColorStop(1, `rgba(${neb.color},0)`);
        ctx.fillStyle = grad;
        ctx.scale(1, ry / rx);
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // ── Constellations ─────────────────────────────────────────────────────
      for (const con of constellations) {
        const alpha = 0.10 + Math.sin(t * 0.4 + con.phase) * 0.04;
        ctx.strokeStyle = `rgba(79,142,247,${alpha})`;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 5]);
        for (const [a, b] of con.edges) {
          ctx.beginPath();
          ctx.moveTo(con.nodes[a].x * w, con.nodes[a].y * h);
          ctx.lineTo(con.nodes[b].x * w, con.nodes[b].y * h);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        for (const node of con.nodes) {
          const nx = node.x * w, ny = node.y * h;
          const pulse = 0.7 + Math.sin(t * 1.5 + con.phase + nx) * 0.3;
          ctx.beginPath();
          ctx.arc(nx, ny, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(167,139,250,${alpha * pulse * 2})`;
          ctx.fill();
          const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, 6);
          ng.addColorStop(0, `rgba(167,139,250,${alpha * 0.5})`);
          ng.addColorStop(1, `rgba(167,139,250,0)`);
          ctx.fillStyle = ng;
          ctx.beginPath();
          ctx.arc(nx, ny, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ── Stars ──────────────────────────────────────────────────────────────
      for (const s of stars) {
        s.a = 0.12 + Math.abs(Math.sin(t * s.twinkleSpeed)) * 0.78;
        s.x += s.drift;
        if (s.x < 0) s.x = 1;
        if (s.x > 1) s.x = 0;
        const alpha = s.a * (s.color === 1 ? 0.88 : 0.68);
        const color = s.color === 1 ? `rgba(210,220,255,${alpha})` : `rgba(110,165,255,${alpha})`;
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (s.r > 1.0 && s.a > 0.65) {
          const gl = s.r * 4;
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.35;
          ctx.globalAlpha = s.a * 0.30;
          ctx.beginPath();
          ctx.moveTo(s.x * w - gl, s.y * h); ctx.lineTo(s.x * w + gl, s.y * h); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(s.x * w, s.y * h - gl); ctx.lineTo(s.x * w, s.y * h + gl); ctx.stroke();
          const dl = gl * 0.55;
          ctx.globalAlpha = s.a * 0.14;
          ctx.beginPath();
          ctx.moveTo(s.x * w - dl, s.y * h - dl); ctx.lineTo(s.x * w + dl, s.y * h + dl); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(s.x * w + dl, s.y * h - dl); ctx.lineTo(s.x * w - dl, s.y * h + dl); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // ── All meteors (diagonal + RTL) ────────────────────────────────────────
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.x += m.vx;
        m.y += m.vy;
        m.life++;
        const lifeRatio = m.life / m.maxLife;
        const alpha = m.a * (lifeRatio < 0.15 ? lifeRatio / 0.15 : 1 - (lifeRatio - 0.15) / 0.85);

        const mx = m.x * w, my = m.y * h;
        // Tail goes OPPOSITE to motion direction
        const tailX = mx - m.vx * w * m.len * (m.rtl ? 10 : 8);
        const tailY = my - m.vy * h * m.len * (m.rtl ? 10 : 8);

        const mg = ctx.createLinearGradient(tailX, tailY, mx, my);
        mg.addColorStop(0, `rgba(200,220,255,0)`);
        if (m.rtl) {
          // RTL star: brighter, bigger, more dramatic
          mg.addColorStop(0.5, `rgba(200,225,255,${alpha * 0.5})`);
          mg.addColorStop(1, `rgba(255,255,255,${alpha})`);
          ctx.strokeStyle = mg;
          ctx.lineWidth = 2.2;
        } else {
          mg.addColorStop(0.6, `rgba(180,210,255,${alpha * 0.4})`);
          mg.addColorStop(1, `rgba(255,255,255,${alpha})`);
          ctx.strokeStyle = mg;
          ctx.lineWidth = 1.5;
        }
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(mx, my);
        ctx.stroke();

        // Head glow — bigger for RTL
        const headR = m.rtl ? 6 : 4;
        const headGrad = ctx.createRadialGradient(mx, my, 0, mx, my, headR);
        headGrad.addColorStop(0, `rgba(240,248,255,${alpha * (m.rtl ? 1.0 : 0.9)})`);
        headGrad.addColorStop(1, `rgba(100,170,255,0)`);
        ctx.fillStyle = headGrad;
        ctx.beginPath();
        ctx.arc(mx, my, headR, 0, Math.PI * 2);
        ctx.fill();

        // Extra outer glow for RTL star
        if (m.rtl) {
          const outerGlow = ctx.createRadialGradient(mx, my, 0, mx, my, 18);
          outerGlow.addColorStop(0, `rgba(120,180,255,${alpha * 0.25})`);
          outerGlow.addColorStop(1, `rgba(79,142,247,0)`);
          ctx.fillStyle = outerGlow;
          ctx.beginPath();
          ctx.arc(mx, my, 18, 0, Math.PI * 2);
          ctx.fill();
        }

        const oob = m.rtl
          ? (m.x < -0.15 || m.y > 1.1 || m.y < -0.1)
          : (m.x > 1.15 || m.y > 1.15);
        if (m.life >= m.maxLife || oob) {
          meteors.splice(i, 1);
        }
      }

      // ── Ripple rings ───────────────────────────────────────────────────────
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.r += 0.7;
        const progress = rp.r / rp.maxR;
        const alpha = rp.a * (1 - progress) * (1 - progress);
        ctx.beginPath();
        ctx.arc(rp.x * w, rp.y * h, rp.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rp.color},${alpha})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        if (rp.r >= rp.maxR) ripples.splice(i, 1);
      }

      // ── Quantum wave lines ─────────────────────────────────────────────────
      for (const line of qLines) {
        const lx = line.x * w, ly = line.y * h;
        const ll = line.len * Math.min(w, h);
        const phase = t * line.speed * 1000 + line.offset;
        const alpha = 0.10 + Math.abs(Math.sin(phase)) * 0.22;
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(line.angle + Math.sin(phase * 0.4) * 0.25);
        const lg = ctx.createLinearGradient(-ll / 2, 0, ll / 2, 0);
        lg.addColorStop(0, `rgba(${line.color},0)`);
        lg.addColorStop(0.5, `rgba(${line.color},${alpha})`);
        lg.addColorStop(1, `rgba(${line.color},0)`);
        ctx.strokeStyle = lg;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(-ll / 2, 0);
        const segs = 44;
        for (let i = 0; i <= segs; i++) {
          const px = -ll / 2 + (ll * i) / segs;
          const py = Math.sin((i / segs) * Math.PI * 3 + phase * 5) * (ll * 0.038);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      }

      // ── Floating particles ─────────────────────────────────────────────────
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy; p.life++;
        const lr = p.life / p.maxLife;
        const alpha = p.a * (lr < 0.1 ? lr * 10 : lr > 0.78 ? (1 - lr) * 4.76 : 1);
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color},${alpha})`;
        ctx.fill();
        const gg = ctx.createRadialGradient(p.x * w, p.y * h, 0, p.x * w, p.y * h, p.r * 5);
        gg.addColorStop(0, `rgba(${p.color},${alpha * 0.32})`);
        gg.addColorStop(1, `rgba(${p.color},0)`);
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.r * 5, 0, Math.PI * 2);
        ctx.fill();
        if (p.life >= p.maxLife || p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) particles.splice(i, 1);
      }

      // ── Hex grid overlay ───────────────────────────────────────────────────
      const hexSize = Math.min(w, h) * 0.052;
      const hexAlpha = 0.018 + Math.sin(t * 0.3) * 0.005;
      ctx.strokeStyle = `rgba(79,142,247,${hexAlpha})`;
      ctx.lineWidth = 0.45;
      const cols = Math.ceil(w / (hexSize * 1.73)) + 2;
      const rows = Math.ceil(h / (hexSize * 1.5)) + 2;
      for (let row = -1; row < rows; row++) {
        for (let col = -1; col < cols; col++) {
          const hx = col * hexSize * 1.732 + (row % 2 === 0 ? 0 : hexSize * 0.866);
          const hy = row * hexSize * 1.5;
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 3) * k - Math.PI / 6;
            const px = hx + hexSize * Math.cos(a);
            const py = hy + hexSize * Math.sin(a);
            k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }

      // ── Distant spiral galaxy (top-right) ─────────────────────────────────
      {
        const gx = w * 0.88, gy = h * 0.1;
        const arms = 3;
        const spiralAlpha = 0.06 + Math.sin(t * 0.2) * 0.015;
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate(t * 0.006);
        for (let arm = 0; arm < arms; arm++) {
          const armAngle = (arm / arms) * Math.PI * 2;
          ctx.beginPath();
          for (let i = 0; i < 60; i++) {
            const frac = i / 60;
            const spiralAngle = armAngle + frac * Math.PI * 2.5;
            const spiralR = frac * 28;
            const sx = Math.cos(spiralAngle) * spiralR;
            const sy = Math.sin(spiralAngle) * spiralR * 0.45;
            i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
          }
          const sg = ctx.createLinearGradient(0, 0, Math.cos(armAngle) * 28, Math.sin(armAngle) * 12);
          sg.addColorStop(0, `rgba(200,210,255,${spiralAlpha * 1.5})`);
          sg.addColorStop(1, `rgba(167,139,250,0)`);
          ctx.strokeStyle = sg;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        const coreG = ctx.createRadialGradient(0, 0, 0, 0, 0, 8);
        coreG.addColorStop(0, `rgba(220,235,255,${spiralAlpha * 2})`);
        coreG.addColorStop(1, `rgba(130,160,255,0)`);
        ctx.fillStyle = coreG;
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // ── Orbital rings ──────────────────────────────────────────────────────
      {
        const rings = [
          { cx: 0.18, cy: 0.55, rx: 0.08, ry: 0.025, angle: -0.3, speed: 0.012, color: "79,142,247", alpha: 0.08 },
          { cx: 0.82, cy: 0.38, rx: 0.06, ry: 0.020, angle:  0.5, speed: -0.009, color: "167,139,250", alpha: 0.07 },
          { cx: 0.55, cy: 0.88, rx: 0.07, ry: 0.022, angle:  0.2, speed: 0.015, color: "79,142,247", alpha: 0.06 },
        ];
        for (const ring of rings) {
          const orbitAngle = ring.angle + t * ring.speed * 10;
          const px = ring.cx * w, py = ring.cy * h;
          const rx = ring.rx * w, ry = ring.ry * h;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(orbitAngle);
          ctx.beginPath();
          ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${ring.color},${ring.alpha})`;
          ctx.lineWidth = 0.6;
          ctx.setLineDash([4, 8]);
          ctx.stroke();
          ctx.setLineDash([]);
          const dotAngle = t * ring.speed * 80;
          const dx = Math.cos(dotAngle) * rx, dy = Math.sin(dotAngle) * ry;
          ctx.beginPath();
          ctx.arc(dx, dy, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${ring.color},${ring.alpha * 3})`;
          ctx.fill();
          const dg = ctx.createRadialGradient(dx, dy, 0, dx, dy, 8);
          dg.addColorStop(0, `rgba(${ring.color},${ring.alpha * 2})`);
          dg.addColorStop(1, `rgba(${ring.color},0)`);
          ctx.fillStyle = dg;
          ctx.beginPath();
          ctx.arc(dx, dy, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    };

    draw();
    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
