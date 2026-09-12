// ============================================================================
//  useData — a small React-Query-style hook for one-off async fetches.
//
//  NOTE ON SCOPE: this is a new, standalone utility. It is NOT wired into any
//  existing component in App.jsx. Every data-fetching component in this app
//  (CampaignReturnRateCard, RfmSegmentsCard, LoyaltyTab, SmsTab, ...) already
//  follows the same small, self-contained pattern —
//    const [data, setData] = useState([]);
//    const [loading, setLoading] = useState(false);
//    useEffect(() => { load(); }, []);
//  — with its own refresh button. Rewiring ~10 components to a shared hook is
//  a real, separate refactor with its own testing surface; this file gives
//  you the hook to adopt gradually, one component at a time, without having
//  to touch everything in one pass.
//
//  Usage:
//    const { data, loading, error, refetch, isStale } = useData(
//      fetchRfmSegments,
//      [],
//      { enabled: true, cacheKey: "rfm_segments", staleAfterMs: 30000 }
//    );
// ============================================================================
import { useState, useEffect, useRef, useCallback } from "react";

const memo = new Map(); // cacheKey -> { value, at }

export function useData(fetcherFunction, params = [], options = {}) {
  const { enabled = true, cacheKey = null, staleAfterMs = 30000 } = options;

  const [data, setData] = useState(() => {
    if (cacheKey && memo.has(cacheKey)) return memo.get(cacheKey).value;
    return undefined;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isStale, setIsStale] = useState(false);

  // Avoids the classic bug where a slow request resolves AFTER the component
  // has moved on (unmounted, or params changed again) and overwrites state
  // with stale data — no AbortController needed since fetcherFunction is a
  // plain async function, not necessarily a fetch() call.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const thisRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherFunction(...params);
      if (requestId.current !== thisRequest) return; // superseded — drop it
      setData(result);
      setIsStale(false);
      if (cacheKey) memo.set(cacheKey, { value: result, at: Date.now() });
    } catch (err) {
      if (requestId.current !== thisRequest) return;
      setError(err);
    } finally {
      if (requestId.current === thisRequest) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cacheKey, ...params]);

  useEffect(() => {
    if (cacheKey && memo.has(cacheKey)) {
      const entry = memo.get(cacheKey);
      setIsStale(Date.now() - entry.at > staleAfterMs);
    }
    load();
    return () => { requestId.current += 1; }; // invalidate any in-flight request on unmount/re-run
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return { data, loading, error, refetch: load, isStale };
}

export default useData;
