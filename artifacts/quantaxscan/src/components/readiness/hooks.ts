import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import type { ReadinessResponse, InventoryAssetsResponse } from "./types";

/** Same shape as `CoverageMeter`/`PostureTimeline`'s fetch hooks: three explicit states, and an error never renders as an empty or zeroed panel. */
function useJson<T>(path: string): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(apiUrl(path))
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (HTTP ${r.status})`);
        return (await r.json()) as T;
      })
      .then((payload) => { if (!cancelled) { setData(payload); setLoading(false); } })
      .catch((err: Error) => { if (!cancelled) { setError(err.message); setData(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [path]);

  return { data, error, loading };
}

/** Row 1 (readiness sections) + Row 3 (estate coverage) — one fetch, so the two can never disagree. */
export function useReadiness() {
  return useJson<ReadinessResponse>("/api/inventory/readiness");
}

/** Row 4's table, Row 2's per-asset drill-down and Row 5's cert-expiry panel — one fetch, filtered client-side. */
export function useInventoryAssets() {
  return useJson<InventoryAssetsResponse>("/api/inventory/assets");
}
