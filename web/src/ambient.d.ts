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
  export interface ExpectStatic {
    (actual: any): any;
    any: (ctor: any) => any;
    objectContaining: (obj: Record<string, any>) => any;
    stringContaining: (str: string) => any;
  }
  export const expect: ExpectStatic;
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
}
