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
  // dataPath lets pages that change columns with the path skip rows fetched for the previous path.
  return { data: result?.data, dataPath: result?.path, error, loading, reload };
}
