/**
 * Typed debounce for search and filter inputs. Cancels pending work on the
 * next call and when the returned disposer runs (e.g. dialog close / destroy).
 */
export type DebouncedFn<Args extends unknown[]> = ((...args: Args) => void) & {
  cancel: () => void;
  flush: (...args: Args) => void;
};

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): DebouncedFn<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Args | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (...args: Args): void => {
    cancel();
    lastArgs = null;
    fn(...args);
  };

  const wrapped = ((...args: Args) => {
    lastArgs = args;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const pending = lastArgs;
      lastArgs = null;
      if (pending) fn(...pending);
    }, waitMs);
  }) as DebouncedFn<Args>;

  wrapped.cancel = cancel;
  wrapped.flush = flush;
  return wrapped;
}
