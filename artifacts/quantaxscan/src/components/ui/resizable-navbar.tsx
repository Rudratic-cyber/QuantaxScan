/**
 * Resizable Navbar — QuantaXscan clean light enterprise theme.
 * White surface, indigo primary, hairline borders.
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
  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 12));
  return (
    <NavbarContext.Provider value={{ scrolled }}>
      <motion.nav
        initial={{ y: -80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
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
        backdropFilter: "blur(12px)",
        backgroundColor: scrolled ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.75)",
        borderBottomColor: scrolled ? "rgba(15,23,42,0.10)" : "rgba(15,23,42,0.06)",
        boxShadow: scrolled ? "0 1px 20px rgba(15,23,42,0.06)" : "0 0 0 rgba(0,0,0,0)",
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
        backdropFilter: "blur(12px)",
        backgroundColor: scrolled ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.8)",
        borderBottomColor: scrolled ? "rgba(15,23,42,0.10)" : "rgba(15,23,42,0.06)",
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
      <motion.span animate={isOpen ? { rotate: 45, y: 6 } : { rotate: 0, y: 0 }}  className="block h-0.5 w-5 bg-[#0a0e1a] rounded-full origin-center" />
      <motion.span animate={isOpen ? { opacity: 0, scaleX: 0 } : { opacity: 1, scaleX: 1 }} className="block h-0.5 w-5 bg-[#0a0e1a] rounded-full" />
      <motion.span animate={isOpen ? { rotate: -45, y: -6 } : { rotate: 0, y: 0 }} className="block h-0.5 w-5 bg-[#0a0e1a] rounded-full origin-center" />
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
          className="overflow-hidden bg-white/98 backdrop-blur-xl border-b border-[#e5e7eb]"
        >
          <div className="px-4 py-5 space-y-1" onClick={onClose}>{children}</div>
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
          className="relative px-3.5 py-2 text-sm font-medium text-[#475569] hover:text-[#0a0e1a] transition-colors duration-200 rounded-lg"
        >
          {hovered === i && (
            <motion.span
              layoutId="nav-hover-pill"
              className="absolute inset-0 rounded-lg bg-[#f1f3f7]"
              transition={{ type: "spring", duration: 0.3, bounce: 0.15 }}
            />
          )}
          <span className="relative z-10">{item.name}</span>
        </a>
      ))}
    </div>
  );
}

interface NavbarLogoProps { href?: string; className?: string; }
export function NavbarLogo({ href = "/", className }: NavbarLogoProps) {
  return (
    <a href={href} className={cn("flex items-center gap-2.5 shrink-0", className)}>
      <div className="relative flex h-7 w-7 items-center justify-center rounded-lg border border-[#e5e7eb] bg-white">
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
          <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#4f46e5" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M2 17l10 5 10-5" stroke="#4f46e5" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M2 12l10 5 10-5" stroke="#0d9488" strokeWidth="1.5" strokeLinejoin="round"/>
        </svg>
      </div>
      <span className="text-base font-bold tracking-tight text-[#0a0e1a]">
        Q-<span style={{ color: "#4f46e5" }}>Vuln</span>
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
  const base = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-all duration-200";
  const styles = {
    primary:
      "bg-[#4f46e5] text-white shadow-sm hover:bg-[#4338ca] hover:-translate-y-px",
    secondary:
      "border border-[#e5e7eb] bg-white text-[#0a0e1a] hover:bg-[#f7f8fa] hover:border-[#d8dce3]",
    ghost: "text-[#475569] hover:text-[#0a0e1a]",
  };
  const props = { className: cn(base, styles[variant], className), onClick };
  if (href) return <a href={href} {...props}>{children}</a>;
  return <button {...props}>{children}</button>;
}
