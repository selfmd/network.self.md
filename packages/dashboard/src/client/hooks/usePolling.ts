import { useState, useEffect } from 'react';

export function usePolling<T>(url: string, intervalMs: number = 5000) {
  const [result, setResult] = useState<{ url: string; data: T | null; error: string | null }>({ url, data: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult((previous) => previous.url === url ? previous : { url, data: null, error: null });

    async function fetchData() {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json() as T;
        if (!controller.signal.aborted) setResult({ url, data, error: null });
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          setResult((previous) => ({ ...previous, error: err instanceof Error ? err.message : String(err) }));
        }
      } finally {
        // Schedule after completion so slow responses cannot overlap or arrive out of order.
        if (!controller.signal.aborted) timer = setTimeout(fetchData, intervalMs);
      }
    }

    void fetchData();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, intervalMs]);

  return result.url === url ? { data: result.data, error: result.error } : { data: null, error: null };
}
