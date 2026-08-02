import React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export const LampBeam = ({ className }: { className?: string }) => {
  return (
    <div className={cn("relative flex w-full items-start justify-center pointer-events-none select-none", className)}>
      {/* Left conic */}
      <motion.div
        initial={{ opacity: 0.3, width: "8rem" }}
        animate={{ opacity: 1, width: "22rem" }}
        transition={{ delay: 0.2, duration: 1.2, ease: "easeInOut" }}
        style={{
          backgroundImage: `conic-gradient(from 70deg at center top, var(--tw-gradient-stops))`,
        }}
        className="absolute top-0 right-1/2 h-48 overflow-hidden bg-gradient-conic from-violet-500 via-transparent to-transparent"
      >
        <div className="absolute bottom-0 left-0 h-32 w-full bg-gradient-to-t from-[#0a0a0f] to-transparent" />
        <div className="absolute bottom-0 left-0 w-12 h-full bg-gradient-to-r from-[#0a0a0f] to-transparent" />
      </motion.div>

      {/* Right conic */}
      <motion.div
        initial={{ opacity: 0.3, width: "8rem" }}
        animate={{ opacity: 1, width: "22rem" }}
        transition={{ delay: 0.2, duration: 1.2, ease: "easeInOut" }}
        style={{
          backgroundImage: `conic-gradient(from 290deg at center top, var(--tw-gradient-stops))`,
        }}
        className="absolute top-0 left-1/2 h-48 overflow-hidden bg-gradient-conic from-transparent via-transparent to-violet-500"
      >
        <div className="absolute bottom-0 right-0 h-32 w-full bg-gradient-to-t from-[#0a0a0f] to-transparent" />
        <div className="absolute bottom-0 right-0 w-12 h-full bg-gradient-to-l from-[#0a0a0f] to-transparent" />
      </motion.div>

      {/* Glow bloom */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10 h-20 w-80 rounded-full bg-violet-500/25 blur-3xl" />

      {/* The beam line itself */}
      <motion.div
        initial={{ width: "6rem", opacity: 0 }}
        animate={{ width: "22rem", opacity: 1 }}
        transition={{ delay: 0.2, duration: 1.2, ease: "easeInOut" }}
        className="absolute top-0 left-1/2 -translate-x-1/2 h-px bg-gradient-to-r from-transparent via-violet-400 to-transparent shadow-[0_0_12px_4px_rgba(139,92,246,0.6)] z-20"
      />

      {/* Centre point glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-violet-300 blur-sm z-30 shadow-[0_0_8px_4px_rgba(196,181,253,0.8)]" />
    </div>
  );
};

export const LampContainer = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div className={cn("relative flex flex-col items-center w-full", className)}>
      <LampBeam />
      <div className="relative z-10 mt-8 flex flex-col items-center px-5 w-full">
        {children}
      </div>
    </div>
  );
};
