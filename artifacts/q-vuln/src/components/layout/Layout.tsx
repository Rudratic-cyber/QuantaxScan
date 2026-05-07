import { ReactNode } from "react";
import { Navbar } from "./Navbar";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-bg-primary text-text-primary dark">
      <Navbar />
      {/*
       * Navbar is `fixed`, so it doesn't occupy flow space.
       * pt-14 (mobile h-14) / md:pt-16 (desktop h-16) pushes
       * every page's content below the navbar bar.
       */}
      <main className="flex-1 flex flex-col pt-14 md:pt-16">
        {children}
      </main>
    </div>
  );
}
