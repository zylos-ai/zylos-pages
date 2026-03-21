// Singleflight: deduplicate concurrent requests for the same key (P0-3)

const inflight = new Map();

/**
 * Ensure only one execution of fn() per key at a time.
 * Concurrent callers with the same key share the same Promise.
 *
 * @returns {{ result: T, shared: boolean }} - shared=true if this caller reused another's result
 */
export async function singleflight(key, fn) {
  if (inflight.has(key)) {
    const result = await inflight.get(key);
    return { result, shared: true };
  }

  const promise = fn().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  const result = await promise;
  return { result, shared: false };
}
