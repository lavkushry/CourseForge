import type { IconName } from '../icons';
import { button as sharedButton, el as sharedEl } from '../components';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  return sharedEl(tag, cls, text);
}

export function button(text: string, action: () => void, cls = 'button', icon?: IconName): HTMLButtonElement {
  return sharedButton(text, action, icon ? { className: cls, icon } : cls);
}

export type AdminTab = 'overview' | 'learners' | 'funnels' | 'retention' | 'ai' | 'audit' | 'activity' | 'system';
export type StudentModalTab = 'courses' | 'security' | 'telemetry';

export function isSyntheticEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    lower.endsWith('@example.test') ||
    lower.endsWith('@fixture.test') ||
    lower.endsWith('@test.local') ||
    lower.endsWith('@courseforge.test')
  );
}

export function initialsOf(name: string, email: string): string {
  const src = (name || email || 'U').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}
