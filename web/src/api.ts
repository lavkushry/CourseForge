/** Compatibility barrel — prefer `./api` or `./api/...` domain modules for new code. */
export { ApiClient, ApiError, errorMessage, isAbort } from './api/index';
export type { RequestOptions } from './api/index';
