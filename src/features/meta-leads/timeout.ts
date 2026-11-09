/**
 * CAP-11, review finding 4: every Graph call ends within PROVIDER_TIMEOUT_MS, well under the claim's two-minute lease, so
 * a slow Meta never lets a lease run out while a fetch is still running. A call that fails or runs late answers the given
 * fallback (an error code); its late result is dropped.
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

export function withTimeout<T>(call: Promise<T>, fallback: T, ms: number = PROVIDER_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
