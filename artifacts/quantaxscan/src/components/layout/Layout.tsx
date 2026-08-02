import { ReactNode } from "react";
import { Navbar } from "./Navbar";
import { Footer } from "./Footer";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-white text-[#0a0e1a]">
      <Navbar />
      {/*
       * Navbar is `fixed`, so it doesn't occupy flow space.
       * pt-14 (mobile h-14) / md:pt-16 (desktop h-16) pushes
       * every page's content below the navbar bar.
       */}
      <main className="flex-1 flex flex-col pt-14 md:pt-16">
        {children}
      </main>
      <Footer />
    </div>
  );
}
