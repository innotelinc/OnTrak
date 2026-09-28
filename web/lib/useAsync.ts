"use client";

/**
 * A tiny fetch hook.
 *
 * Deliberately not a data-fetching library: every page here loads one or two
 * endpoints, and the only behaviour that matters is that a failed load is
 * *visible* — a dashboard that renders stale numbers when its API call fails is
 * worse than one that says it could not load, because patch state is exactly the
 * thing people act on without checking twice.
 *
 * `reload` is returned so an action (scan, approve, apply) can refresh the page's
 * data without a full navigation.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  // Guards against a slow first request overwriting a newer one's result, which is
  // how a filtered list ends up showing the unfiltered payload.
  const generation = useRef(0);
  const load = useRef(loader);
  load.current = loader;

  useEffect(() => {
    const mine = ++generation.current;
    let cancelled = false;
    setLoading(true);
    load
      .current()
      .then((value) => {
        if (cancelled || mine !== generation.current) return;
        setData(value);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled || mine !== generation.current) return;
        setError(cause);
      })
      .finally(() => {
        if (cancelled || mine !== generation.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}
