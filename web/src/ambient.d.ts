declare module 'media-chrome' {
  const content: Record<string, unknown>;
  export default content;
}

declare module 'vitest' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export interface Assertion {
    toBe: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
    toThrow: (expected?: unknown) => void;
    toContain: (expected: unknown) => void;
    toMatchObject: (expected: object) => void;
    toMatch: (expected: string | RegExp) => void;
    toHaveLength: (length: number) => void;
    toBeNull: () => void;
    toBeInstanceOf: (ctor: abstract new (...args: never[]) => unknown) => void;
    toBeGreaterThanOrEqual: (expected: number) => void;
    toHaveBeenCalled: () => void;
    toHaveBeenCalledOnce: () => void;
    toHaveBeenCalledTimes: (times: number) => void;
    toHaveBeenCalledWith: (...args: unknown[]) => void;
    not: Assertion;
    resolves: Assertion;
    rejects: Assertion;
  }
  export interface ExpectStatic {
    (actual: unknown): Assertion;
    any: (ctor: unknown) => unknown;
    objectContaining: (obj: Record<string, unknown>) => unknown;
    stringContaining: (str: string) => unknown;
  }
  export const expect: ExpectStatic;
  // The mock surface below intentionally mirrors vitest's own loose typing:
  // a MockInstance must stay assignable to whatever function type it stands
  // in for (fetch, callbacks, server methods), which is only expressible
  // with any. Keep it confined to this stub; app code stays fully typed.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export interface MockInstance<T extends (...args: any[]) => any = (...args: any[]) => any> {
    (...args: Parameters<T>): ReturnType<T>;
    mock: {
      calls: Parameters<T>[];
    };
    mockImplementation: (fn: (...args: Parameters<T>) => ReturnType<T>) => this;
    mockImplementationOnce: (fn: (...args: Parameters<T>) => ReturnType<T>) => this;
    mockResolvedValue: (val: Awaited<ReturnType<T>>) => this;
    mockResolvedValueOnce: (val: Awaited<ReturnType<T>>) => this;
    mockRejectedValue: (err: any) => this;
    mockRejectedValueOnce: (err: any) => this;
  }
  export const vi: {
    fn: <T extends (...args: any[]) => any = (...args: any[]) => any>(impl?: T) => MockInstance<T>;
    mocked: <T extends (...args: any[]) => any>(item: T) => MockInstance<T>;
    spyOn: (obj: any, method: string) => any;
    useFakeTimers: () => void;
    useRealTimers: () => void;
    advanceTimersByTime: (ms: number) => void;
    advanceTimersByTimeAsync: (ms: number) => Promise<void>;
    stubGlobal: (name: string, value: any) => void;
    restoreAllMocks: () => void;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
