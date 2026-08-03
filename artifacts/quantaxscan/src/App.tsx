import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout/Layout";
import { Home } from "@/pages/Home";
import { Scan } from "@/pages/Scan";
import { Demo } from "@/pages/Demo";
import { Dashboard } from "@/pages/Dashboard";
import { Community } from "@/pages/Community";
import { CreatePost } from "@/pages/CreatePost";
import { Report } from "@/pages/Report";
import { Coverage } from "@/pages/Coverage";
import { Security } from "@/pages/Security";
import { IntroScreen } from "@/components/IntroScreen";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { motion } from "framer-motion";
import { useState } from "react";

const queryClient = new QueryClient();

// Intro plays once per page-load (module variable resets on every hard refresh).
// SPA navigation back to "/" within the same tab won't replay it.
const INTRO_KEY = "quantaxscan_intro_seen";
let introHasPlayed = false;

function introAlreadySeen() {
  return introHasPlayed;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/scan" component={Scan} />
      <Route path="/coverage" component={Coverage} />
      <Route path="/security" component={Security} />
      <Route path="/demo/:slug" component={Demo} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/community/create" component={CreatePost} />
      <Route path="/community" component={Community} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppInner() {
  const [location]  = useLocation();
  const isHome      = location === "/";
  const isReport    = location.startsWith("/report/");
  const [introDone, setIntroDone] = useState(introAlreadySeen);

  const handleIntroDone = () => {
    introHasPlayed = true;
    try { sessionStorage.setItem(INTRO_KEY, "1"); } catch { /* ignore */ }
    setIntroDone(true);
  };

  // Report pages are fully standalone — no Layout, no intro, no animation wrapper.
  // Boundary: /report/:id is a public shareable URL, so a malformed stored payload must not
  // hand the recipient a blank white page.
  if (isReport) {
    return (
      <ErrorBoundary>
        <Route path="/report/:id" component={Report} />
      </ErrorBoundary>
    );
  }

  return (
    <>
      {isHome && !introDone && (
        <IntroScreen onDone={handleIntroDone} />
      )}
      <motion.div
        animate={
          introDone || !isHome
            ? { opacity: 1, scale: 1, filter: "blur(0px)" }
            : { opacity: 0, scale: 0.96, filter: "blur(6px)" }
        }
        transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
        style={{ willChange: "transform, opacity, filter" }}
      >
        <Layout>
          <AppRouter />
        </Layout>
      </motion.div>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppInner />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
