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
import { QuantaXscanLogo } from "@/components/QuantaXscanLogo";
import { TerminalHint } from "@/components/EasterEggs";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";

// Center nav
const CENTER_NAV = [
  { name: "Scanner",   link: "/scan" },
  { name: "Coverage",  link: "/coverage" },
  { name: "Dashboard", link: "/dashboard" },
  { name: "OT Register", link: "/ot-register" },
  { name: "Security",  link: "/security" },
  { name: "Community", link: "/community" },
];

// All items for mobile
const ALL_NAV = [
  { name: "Scanner",   link: "/scan" },
  { name: "Coverage",  link: "/coverage" },
  { name: "Dashboard", link: "/dashboard" },
  { name: "OT Register", link: "/ot-register" },
  { name: "Security",  link: "/security" },
  { name: "Community", link: "/community" },
  { name: "Demo",      link: "/demo/paramiko-ssh" },
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
            animate={{ x: Math.cos(angle) * 26, y: Math.sin(angle) * 26, opacity: 0, scale: 0.2 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="absolute w-1.5 h-1.5 rounded-full bg-[#4f46e5] pointer-events-none z-50"
            style={{ top: "50%", left: "50%", marginTop: -3, marginLeft: -3 }}
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
            ? { rotate: 360, scale: [1, 1.25, 1] }
            : { rotate: 0,   scale: 1 }}
          transition={{ duration: 0.55, ease: "easeInOut" }}
        >
          <QuantaXscanLogo variant="icon" size="sm" />
        </motion.div>
        <span
          className="font-bold tracking-tight text-base text-[#0a0e1a] leading-none"
          style={{ letterSpacing: "-0.02em" }}
        >
          Quanta<span style={{ color: "#4f46e5" }}>Xscan</span>
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
        {/* ── Left: Logo ── */}
        <div className="flex items-center gap-3" style={{ flex: "1 1 0" }}>
          <NavLogo />
        </div>

        {/* ── Center: nav ── */}
        <div className="flex items-center justify-center" style={{ flex: "2 1 0" }}>
          <NavItems items={CENTER_NAV} />
        </div>

        {/* ── Right: CTA ── */}
        <div className="flex items-center justify-end gap-2" style={{ flex: "1 1 0" }}>
          <NavbarButton variant="ghost" href="/demo/paramiko-ssh" className="hidden lg:inline-flex">
            View a demo
          </NavbarButton>
          <NavbarButton variant="primary" href="/scan">Scan a repository</NavbarButton>
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
              className="block py-2.5 text-sm font-medium text-[#475569] hover:text-[#0a0e1a] transition-colors"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              {item.name}
            </a>
          ))}
          <div className="pt-3 flex flex-col gap-2 border-t border-[#e5e7eb] mt-2">
            <NavbarButton variant="primary" href="/scan">Scan a repository</NavbarButton>
          </div>
        </MobileNavMenu>
      </MobileNav>
    </NavbarRoot>
  );
}
