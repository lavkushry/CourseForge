import { cn, type ClassValue } from './shadcn';

export type PanelSkeletonVariant = 'panel' | 'cards' | 'lines' | 'history';

export interface PanelSkeletonOptions {
  /** Number of placeholder blocks. Defaults by variant. */
  count?: number;
  variant?: PanelSkeletonVariant;
  className?: ClassValue;
  label?: string;
}

function block(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/**
 * Shared loading skeleton for workspace panels. Prefer this over a bare
 * "Loading…" paragraph so route transitions keep cinema/LMS surface density.
 */
export function panelSkeleton(options: PanelSkeletonOptions = {}): HTMLElement {
  const variant = options.variant ?? 'panel';
  const count =
    options.count ??
    (variant === 'cards' ? 6 : variant === 'history' ? 4 : variant === 'lines' ? 5 : 3);

  const host = document.createElement('div');
  host.className = cn('cf-panel-skeleton', `cf-panel-skeleton--${variant}`, options.className);
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-busy', 'true');
  host.dataset.slot = 'skeleton';
  host.dataset.shadcn = 'skeleton';

  const label = options.label ?? 'Loading…';
  const sr = document.createElement('span');
  sr.className = 'cf-skeleton-label';
  sr.textContent = label;
  host.append(sr);

  switch (variant) {
    case 'cards': {
      host.className = cn(host.className, 'cf-panel-skeleton-grid', 'course-grid');
      for (let i = 0; i < count; i++) host.append(block('course-skeleton'));
      break;
    }
    case 'history': {
      host.className = cn(host.className, 'cf-panel-skeleton-grid', 'history-grid', 'history-loading');
      for (let i = 0; i < count; i++) host.append(block('history-card-skeleton'));
      break;
    }
    case 'lines': {
      for (let i = 0; i < count; i++) {
        host.append(block(cn('cf-skeleton-line', i === 0 && 'cf-skeleton-line--wide')));
      }
      break;
    }
    case 'panel': {
      host.append(block('cf-skeleton-line cf-skeleton-line--wide'));
      host.append(block('cf-skeleton-line'));
      const body = document.createElement('div');
      body.className = 'cf-panel-skeleton-body';
      for (let i = 0; i < count; i++) body.append(block('cf-skeleton-block'));
      host.append(body);
      break;
    }
    default: {
      const _exhaustive: never = variant;
      void _exhaustive;
      break;
    }
  }

  return host;
}

/** Compact inline status skeleton for nested cards (settings, roadmap tab). */
export function inlineSkeleton(label = 'Loading…', className?: ClassValue): HTMLElement {
  return panelSkeleton({ variant: 'lines', count: 3, label, className: cn('cf-panel-skeleton--inline', className) });
}
