import { ContractError } from '../validation';

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new ContractError(label);
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
