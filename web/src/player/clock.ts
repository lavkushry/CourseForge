export type Timer = ReturnType<typeof globalThis.setTimeout>;

export interface Clock {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delayMs: number): Timer;
  clearTimeout(timer: Timer): void;
}

export const browserClock: Clock = {
  now: () => performance.now(),
  random: () => Math.random(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: timer => globalThis.clearTimeout(timer),
};

export function wait(clock: Clock, delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clock.clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = clock.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
