import type { AuthResponse } from '../contracts';
import { parseAuth } from '../validation';
import { ApiError } from './errors';
import type { HttpClient } from './http';

export async function login(
  client: HttpClient & { setAuth(auth: AuthResponse): void },
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<AuthResponse> {
  const auth = await client
    .request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      ...(signal ? { signal } : {}),
    })
    .then(parseAuth);
  client.setAuth(auth);
  return auth;
}

export async function register(
  client: HttpClient & { setAuth(auth: AuthResponse): void },
  name: string,
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<AuthResponse> {
  const auth = await client
    .request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: { name, email, password },
      ...(signal ? { signal } : {}),
    })
    .then(parseAuth);
  client.setAuth(auth);
  return auth;
}

export async function me(
  client: HttpClient & { setAuth(auth: AuthResponse): void },
  signal?: AbortSignal,
): Promise<AuthResponse> {
  const auth = await client.request<AuthResponse>('/auth/me', signal ? { signal } : {}).then(parseAuth);
  client.setAuth(auth);
  return auth;
}

export async function logout(client: HttpClient & { clearAuth(): void }): Promise<void> {
  await client.request<void>('/auth/logout', { method: 'POST', body: {} });
  client.clearAuth();
}

export function applyAuth(client: HttpClient & { setCsrfToken(token: string): void }, auth: AuthResponse): void {
  if (!auth?.user?.id || typeof auth.csrf_token !== 'string') throw new ApiError('Invalid sign-in response.', 502);
  client.setCsrfToken(auth.csrf_token);
}
