/**
 * Resizable Navbar — Q-Bitron developer/sci-fi theme
 * Electric blue primary, deep space backgrounds.
 */
import React, { useState } from "react";
import { motion, useScroll, useMotionValueEvent, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

interface NavbarContextValue { scrolled: boolean; }
const NavbarContext = React.createContext<NavbarContextValue>({ scrolled: false });

interface NavbarProps { children: React.ReactNode; className?: string; }
export function Navbar({ children, className }: NavbarProps) {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 20));
  return (
    <NavbarContext.Provider value={{ scrolled }}>
      <motion.nav
        initial={{ y: -80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className={cn("fixed top-0 inset-x-0 z-50 w-full", className)}
      >
        {children}
      </motion.nav>
    </NavbarContext.Provider>
  );
}

interface NavBodyProps { children: React.ReactNode; className?: string; }
export function NavBody({ children, className }: NavBodyProps) {
  const { scrolled } = React.useContext(NavbarContext);
  return (
    <motion.div
      animate={{
        backdropFilter: scrolled ? "blur(24px)" : "blur(16px)",
        backgroundColor: scrolled ? "rgba(5,8,16,0.98)" : "rgba(5,8,16,0.88)",
        borderBottomColor: scrolled ? "rgba(79,142,247,0.28)" : "rgba(79,142,247,0.12)",
        boxShadow: scrolled
          ? "0 4px 40px rgba(0,0,0,0.8), 0 1px 0 rgba(79,142,247,0.18), 0 0 60px rgba(79,142,247,0.07), inset 0 1px 0 rgba(79,142,247,0.06)"
          : "0 1px 0 rgba(79,142,247,0.10), 0 0 30px rgba(79,142,247,0.04)",
      }}
      transition={{ duration: 0.25 }}
      className={cn("hidden md:flex items-center h-16 px-6 border-b gap-4", className)}
    >
      {children}
    </motion.div>
  );
}

export function MobileNav({ children }: { children: React.ReactNode }) {
  return <div className="md:hidden">{children}</div>;
}

export function MobileNavHeader({ children }: { children: React.ReactNode }) {
  const { scrolled } = React.useContext(NavbarContext);
  return (
    <motion.div
      animate={{
        backdropFilter: scrolled ? "blur(24px)" : "blur(16px)",
        backgroundColor: scrolled ? "rgba(5,8,16,0.98)" : "rgba(5,8,16,0.88)",
        borderBottomColor: scrolled ? "rgba(79,142,247,0.22)" : "rgba(79,142,247,0.10)",
      }}
      transition={{ duration: 0.25 }}
      className="flex items-center justify-between h-14 px-4 border-b"
    >
      {children}
    </motion.div>
  );
}

interface MobileNavToggleProps { isOpen: boolean; onClick: () => void; }
export function MobileNavToggle({ isOpen, onClick }: MobileNavToggleProps) {
  return (
    <button onClick={onClick} className="relative h-8 w-8 flex flex-col items-center justify-center gap-1.5" aria-label="Toggle menu">
      <motion.span animate={isOpen ? { rotate: 45, y: 6 } : { rotate: 0, y: 0 }}  className="block h-0.5 w-5 bg-[#f1f5f9] rounded-full origin-center" />
      <motion.span animate={isOpen ? { opacity: 0, scaleX: 0 } : { opacity: 1, scaleX: 1 }} className="block h-0.5 w-5 bg-[#f1f5f9] rounded-full" />
      <motion.span animate={isOpen ? { rotate: -45, y: -6 } : { rotate: 0, y: 0 }} className="block h-0.5 w-5 bg-[#f1f5f9] rounded-full origin-center" />
    </button>
  );
}

interface MobileNavMenuProps { isOpen: boolean; onClose: () => void; children: React.ReactNode; }
export function MobileNavMenu({ isOpen, onClose, children }: MobileNavMenuProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="mobile-menu"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: "easeInOut" }}
          className="overflow-hidden bg-[#050810]/98 backdrop-blur-2xl border-b border-[#4f8ef7]/15"
        >
          <div className="px-4 py-5 space-y-3" onClick={onClose}>{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface NavItem { name: string; link: string; }
interface NavItemsProps { items: NavItem[]; className?: string; onItemClick?: () => void; }
export function NavItems({ items, className, onItemClick }: NavItemsProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {items.map((item, i) => (
        <a
          key={item.name}
          href={item.link}
          onClick={onItemClick}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
          className="relative px-4 py-2 text-sm font-mono text-[#94a3b8] hover:text-[#f1f5f9] transition-colors duration-200 rounded-lg"
        >
          {hovered === i && (
            <motion.span
              layoutId="nav-hover-pill"
              className="absolute inset-0 rounded-lg bg-[#4f8ef7]/8 border border-[#4f8ef7]/20"
              transition={{ type: "spring", duration: 0.3, bounce: 0.15 }}
            />
          )}
          <span className="relative z-10">
            <span className="text-[#4f8ef7]/50 mr-0.5">./</span>{item.name.toLowerCase()}
          </span>
        </a>
      ))}
    </div>
  );
}

interface NavbarLogoProps { href?: string; className?: string; }
export function NavbarLogo({ href = "/", className }: NavbarLogoProps) {
  return (
    <a href={href} className={cn("flex items-center gap-2.5 shrink-0", className)}>
      <div className="relative h-7 w-7">
        <div className="absolute inset-0 rounded-lg bg-[#4f8ef7]/15 blur-sm" />
        <div className="relative flex h-full w-full items-center justify-center rounded-lg border border-[#4f8ef7]/35 bg-[#050810]">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#4f8ef7" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M2 17l10 5 10-5" stroke="#4f8ef7" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M2 12l10 5 10-5" stroke="#7c6af5" strokeWidth="1.5" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>
      <span className="text-base font-mono font-bold tracking-tight text-[#f1f5f9]">
        Q-<span style={{ color: "#4f8ef7" }}>BITRON</span>
      </span>
    </a>
  );
}

interface NavbarButtonProps {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  onClick?: () => void;
  href?: string;
  className?: string;
}
export function NavbarButton({ children, variant = "primary", onClick, href, className }: NavbarButtonProps) {
  const base = "inline-flex items-center justify-center rounded-lg px-4 py-1.5 text-sm font-mono font-semibold transition-all duration-200";
  const styles = {
    primary:
      "border border-[#4f8ef7] bg-[#4f8ef7]/12 text-[#4f8ef7] shadow-[0_0_14px_rgba(79,142,247,0.22)] hover:bg-[#4f8ef7]/22 hover:shadow-[0_0_26px_rgba(79,142,247,0.45)] hover:-translate-y-px",
    secondary:
      "border border-white/12 bg-white/4 text-[#cbd5e1] hover:text-[#f1f5f9] hover:border-white/22 hover:bg-white/8",
    ghost: "text-[#94a3b8] hover:text-[#f1f5f9]",
  };
  const props = { className: cn(base, styles[variant], className), onClick };
  if (href) return <a href={href} {...props}>{children}</a>;
  return <button {...props}>{children}</button>;
}
