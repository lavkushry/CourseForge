/** Client-side admin gate helpers — Go still enforces /admin. */

export function canAccessAdmin(role: string | null | undefined): boolean {
  return role === 'admin';
}

export function adminDeniedCopy(): { title: string; description: string } {
  return {
    title: 'Administrator access required',
    description: 'The Command Center is limited to admin roles. Non-admin sessions cannot open admin UI routes.',
  };
}
