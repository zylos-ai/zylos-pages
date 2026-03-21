// Singleflight: deduplicate concurrent requests for the same key (P0-3)

const inflight = new Map();

/**
 * Ensure only one execution of fn() per key at a time.
 * Concurrent callers with the same key share the same Promise.
 */
export async function singleflight(key, fn) {
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = fn().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}
