export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = '',
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get terminal(): boolean {
    return [400, 401, 403, 404, 409, 410, 422].includes(this.status);
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not complete.';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
