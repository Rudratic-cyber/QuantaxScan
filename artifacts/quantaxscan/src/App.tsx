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
import { Readiness } from "@/pages/Readiness";
import { Community } from "@/pages/Community";
import { CreatePost } from "@/pages/CreatePost";
import { Report } from "@/pages/Report";
import { Coverage } from "@/pages/Coverage";
import { Security } from "@/pages/Security";
import { OtRegister } from "@/pages/OtRegister";
import { IntroScreen } from "@/components/IntroScreen";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { motion } from "framer-motion";
import { useState } from "react";

/**
 * Do not retry a client error.
 *
 * The default is three retries with exponential backoff, which is right for a network blip and
 * wrong for a 401. Today every dashboard request is refused — the browser bundle carries no API
 * key (S1) — so the default spent about ten seconds re-asking a question already answered before
 * showing "Projects could not be loaded". Ten seconds of "Loading projects…" for a deterministic
 * refusal is the honest-state work undone by a default: the copy exists precisely so a refusal is
 * never mistaken for an empty inventory, and a long spinner is a third state that says neither.
 *
 * 408 and 429 are excluded because they *are* worth retrying — a timeout and a rate limit both
 * clear on their own, and S6 is about to start returning 429 with a Retry-After.
 */
const RETRYABLE_CLIENT_ERRORS = new Set([408, 429]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as { status?: unknown } | null)?.status;
        if (
          typeof status === "number" &&
          status >= 400 &&
          status < 500 &&
          !RETRYABLE_CLIENT_ERRORS.has(status)
        ) {
          return false;
        }
        return failureCount < 3;
      },
    },
  },
});

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
      <Route path="/ot-register" component={OtRegister} />
      <Route path="/demo/:slug" component={Demo} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/readiness" component={Readiness} />
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
