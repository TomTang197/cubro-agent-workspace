import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function useApi<T>(path: string | null) {
  const [result, setResult] = useState<{ path: string; data: T }>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    if (!path) return;
    let current = true;
    setLoading(true);
    api<T>(path).then((data) => { if (current) { setResult({ path, data }); setError(undefined); } }).catch((e) => current && setError(String(e.message ?? e))).finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [path]);
  useEffect(() => reload(), [reload]);
  // Never hand back rows fetched for a different path: pages render them with the new path's columns.
  return { data: result?.path === path ? result.data : undefined, error, loading, reload };
}
