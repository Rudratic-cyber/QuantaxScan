import { useState } from "react";
import {
  Navbar as NavbarRoot,
  NavBody,
  NavItems,
  NavbarButton,
  MobileNav,
  MobileNavHeader,
  MobileNavToggle,
  MobileNavMenu,
} from "@/components/ui/resizable-navbar";
import { QBitronLogo } from "@/components/QBitronLogo";
import { TerminalHint } from "@/components/EasterEggs";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";

// Center nav — Scanner, Dashboard, Community, Discord
const CENTER_NAV = [
  { name: "Scanner",   link: "/scan" },
  { name: "Dashboard", link: "/dashboard" },
  { name: "Community", link: "/community" },
  { name: "Discord",   link: "https://discord.gg/qReVaR2TpC", external: true },
];

// All items for mobile
const ALL_NAV = [
  { name: "Demo",      link: "/demo/paramiko-ssh" },
  { name: "Scanner",   link: "/scan" },
  { name: "Dashboard", link: "/dashboard" },
  { name: "Community", link: "/community" },
];

function QuantumBurst({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <AnimatePresence>
      {[...Array(8)].map((_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        return (
          <motion.span
            key={i}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: Math.cos(angle) * 30, y: Math.sin(angle) * 30, opacity: 0, scale: 0.2 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="absolute w-2 h-2 rounded-full bg-[#4f8ef7] pointer-events-none z-50"
            style={{ top: "50%", left: "50%", marginTop: -4, marginLeft: -4 }}
          />
        );
      })}
    </AnimatePresence>
  );
}

function NavLogo() {
  const [, navigate] = useLocation();
  const [burst, setBurst]     = useState(false);
  const [spinning, setSpinning] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (spinning) return;
    setBurst(true);
    setSpinning(true);
    setTimeout(() => setBurst(false), 600);
    setTimeout(() => { setSpinning(false); navigate("/"); }, 650);
  };

  return (
    <TerminalHint>
      <a
        href="/"
        onClick={handleClick}
        className="relative flex items-center gap-2.5 shrink-0 select-none group"
        style={{ minWidth: 0 }}
      >
        <QuantumBurst active={burst} />
        <motion.div
          animate={spinning
            ? { rotate: 360, scale: [1, 1.35, 1] }
            : { rotate: 0,   scale: 1 }}
          transition={{ duration: 0.55, ease: "easeInOut" }}
        >
          <QBitronLogo variant="icon" size="sm" glow />
        </motion.div>
        <span
          className="font-mono font-bold tracking-tight text-base text-[#f1f5f9] leading-none"
          style={{
            letterSpacing: "-0.02em",
            textShadow: spinning
              ? "0 0 18px rgba(79,142,247,1), 0 0 36px rgba(167,139,250,0.8)"
              : "0 0 10px rgba(79,142,247,0.4)",
          }}
        >
          Q-<span style={{ color: "#4f8ef7" }}>BITRON</span>
        </span>
      </a>
    </TerminalHint>
  );
}

export function Navbar() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <NavbarRoot>
      <NavBody>
        {/* ── Left: Logo + Demo outlined pill ── */}
        <div className="flex items-center gap-3" style={{ flex: "1 1 0" }}>
          <NavLogo />
          {/* Demo button — outlined, right next to logo */}
          <a
            href="/demo/paramiko-ssh"
            className="relative group hidden lg:inline-flex items-center gap-1.5 rounded-lg border border-[#4f8ef7]/35 bg-[#4f8ef7]/6 px-3.5 py-1.5 text-xs font-mono font-semibold text-[#4f8ef7] transition-all duration-200 hover:border-[#4f8ef7]/65 hover:bg-[#4f8ef7]/14 hover:shadow-[0_0_16px_rgba(79,142,247,0.25)]"
          >
            <span className="text-[#4f8ef7]/50">./</span>demo
            {/* Subtle pulsing dot */}
            <span className="h-1.5 w-1.5 rounded-full bg-[#4f8ef7] animate-pulse ml-0.5" />
          </a>
        </div>

        {/* ── Center: Scanner | Dashboard | Community | Discord ── */}
        <div className="flex items-center justify-center" style={{ flex: "1 1 0" }}>
          <NavItems items={CENTER_NAV.filter(item => !item.external)} />
          {/* Discord button */}
          <a
            href="https://discord.gg/qReVaR2TpC"
            target="_blank"
            rel="noopener noreferrer"
            className="relative group hidden lg:inline-flex items-center gap-1.5 ml-3 rounded-lg border border-[#5865F2]/35 bg-[#5865F2]/6 px-3.5 py-1.5 text-xs font-mono font-semibold text-[#5865F2] transition-all duration-200 hover:border-[#5865F2]/65 hover:bg-[#5865F2]/14 hover:shadow-[0_0_16px_rgba(88,101,242,0.25)]"
          >
            discord
          </a>
        </div>

        {/* ── Right: Auth + CTA ── */}
        <div className="flex items-center justify-end gap-3" style={{ flex: "1 1 0" }}>
          <NavbarButton variant="primary" href="/scan">./scan --now</NavbarButton>
        </div>
      </NavBody>

      {/* ── Mobile ── */}
      <MobileNav>
        <MobileNavHeader>
          <NavLogo />
          <MobileNavToggle isOpen={isMobileMenuOpen} onClick={() => setIsMobileMenuOpen(v => !v)} />
        </MobileNavHeader>
        <MobileNavMenu isOpen={isMobileMenuOpen} onClose={() => setIsMobileMenuOpen(false)}>
          {ALL_NAV.map((item) => (
            <a
              key={item.name}
              href={item.link}
              className="block py-2 text-sm font-mono text-[#94a3b8] hover:text-[#f1f5f9] transition-colors"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <span className="text-[#4f8ef7]/40 mr-1">./</span>{item.name.toLowerCase()}
            </a>
          ))}
          <a
            href="https://discord.gg/qReVaR2TpC"
            target="_blank"
            rel="noopener noreferrer"
            className="block py-2 text-sm font-mono text-[#5865F2] hover:text-[#7289DA] transition-colors"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <span className="text-[#5865F2]/40 mr-1">./</span>discord
          </a>
          <div className="pt-3 flex flex-col gap-2 border-t border-[#4f8ef7]/10 mt-2">
            <NavbarButton variant="primary" href="/scan">./scan --now</NavbarButton>
          </div>
        </MobileNavMenu>
      </MobileNav>
    </NavbarRoot>
  );
}
