/**
 * CourseForge TS+Go — Tailwind CSS + shadcn/ui Component Primitive & Cross-Platform Adaptive Engine
 * Provides class-variance composition (`cn`), semantic `data-slot` / `data-shadcn` primitive tagging,
 * and cross-platform runtime adaptation for iOS, Android, macOS, and Windows Desktop.
 */

export type PlatformOS = 'ios' | 'android' | 'macos' | 'windows' | 'linux';
export type FormFactor = 'compact' | 'medium' | 'expanded';

export interface PlatformCapabilities {
  os: PlatformOS;
  formFactor: FormFactor;
  sizeClass: FormFactor;
  touch: boolean;
  standalonePWA: boolean;
}

export type ClassValue = string | undefined | null | false | ClassValue[];

/**
 * Merges Tailwind / shadcn class names cleanly, filtering out falsy values, nested arrays, and duplicates.
 */
export function cn(...inputs: ClassValue[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (item: ClassValue): void => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const sub of item) visit(sub);
      return;
    }
    for (const token of item.trim().split(/\s+/)) {
      if (token && !seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  };
  for (const input of inputs) visit(input);
  return out.join(' ');
}

export type ShadcnButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
export type ShadcnButtonSize = 'default' | 'sm' | 'lg' | 'icon';
export type ShadcnBadgeVariant =
  'default' | 'secondary' | 'outline' | 'destructive' | 'purple' | 'terracotta' | 'ocean' | 'emerald';

export function shadcnButtonClass(
  variant: ShadcnButtonVariant = 'default',
  size: ShadcnButtonSize = 'default',
  extra?: ClassValue,
): string {
  const variantMap: Record<ShadcnButtonVariant, string> = {
    default: 'button primary cf-shadcn-btn cf-shadcn-btn--default',
    secondary: 'button cf-shadcn-btn cf-shadcn-btn--secondary',
    outline: 'button quiet cf-shadcn-btn cf-shadcn-btn--outline',
    ghost: 'button quiet cf-shadcn-btn cf-shadcn-btn--ghost',
    destructive: 'button cf-shadcn-btn cf-shadcn-btn--destructive',
    link: 'text-button cf-shadcn-btn cf-shadcn-btn--link',
  };
  const sizeMap: Record<ShadcnButtonSize, string> = {
    default: 'cf-shadcn-btn--md',
    sm: 'cf-shadcn-btn--sm',
    lg: 'cf-shadcn-btn--lg',
    icon: 'icon-only-btn cf-shadcn-btn--icon',
  };
  return cn(variantMap[variant], sizeMap[size], extra);
}

export function shadcnBadgeClass(variant: ShadcnBadgeVariant = 'default', extra?: ClassValue): string {
  const map: Record<ShadcnBadgeVariant, string> = {
    default: 'course-badge cf-shadcn-badge cf-shadcn-badge--default',
    secondary: 'meta-chip cf-shadcn-badge cf-shadcn-badge--secondary',
    outline: 'meta-chip cf-shadcn-badge cf-shadcn-badge--outline',
    destructive: 'lesson-badge-pill cf-shadcn-badge cf-shadcn-badge--destructive',
    purple: 'lesson-badge-pill pill-purple cf-shadcn-badge',
    terracotta: 'lesson-badge-pill pill-terracotta cf-shadcn-badge',
    ocean: 'lesson-badge-pill pill-ocean cf-shadcn-badge',
    emerald: 'lesson-badge-pill pill-emerald cf-shadcn-badge',
  };
  return cn(map[variant], extra);
}

export function shadcnCardClass(interactive = false, extra?: ClassValue): string {
  return cn('course-card cf-shadcn-card', interactive && 'cf-shadcn-card--interactive', extra);
}

export function shadcnInputClass(extra?: ClassValue): string {
  return cn('form-input cf-shadcn-input', extra);
}

/**
 * Detects the active OS (`ios`, `android`, `macos`, `windows`, `linux`) and Material 3 / Apple HIG
 * window size class (`compact` < 640px, `medium` 640-1024px, `expanded` > 1024px).
 */
export function detectPlatformCapabilities(
  ua = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  width = typeof window !== 'undefined' ? window.innerWidth : 1440,
): PlatformCapabilities {
  const lower = ua.toLowerCase();
  let os: PlatformOS = 'linux';
  if (
    /iphone|ipad|ipod/.test(lower) ||
    (/macintosh/.test(lower) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
  ) {
    os = 'ios';
  } else if (/android/.test(lower)) {
    os = 'android';
  } else if (/macintosh|mac os x/.test(lower)) {
    os = 'macos';
  } else if (/windows|win32|win64/.test(lower)) {
    os = 'windows';
  }

  const formFactor: FormFactor = width < 640 ? 'compact' : width <= 1024 ? 'medium' : 'expanded';
  const touch = os === 'ios' || os === 'android' || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  const standalonePWA =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches === true ||
      ('standalone' in navigator && Boolean((navigator as unknown as { standalone?: boolean }).standalone)));

  return { os, formFactor, sizeClass: formFactor, touch, standalonePWA };
}

/**
 * Applies shadcn/ui `data-slot` attributes and platform adaptive dataset flags to the DOM
 * without mutating existing IDs, classes, or event listeners.
 */
export function mountAdaptiveShadcnRoot(
  root: HTMLElement = document.documentElement,
  signal?: AbortSignal,
): PlatformCapabilities {
  const update = (): PlatformCapabilities => {
    const caps = detectPlatformCapabilities();
    root.dataset.platform = caps.os;
    root.dataset.formFactor = caps.formFactor;
    root.dataset.sizeClass = caps.sizeClass;
    root.dataset.touch = String(caps.touch);
    return caps;
  };

  const initial = update();
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'resize',
      () => {
        update();
      },
      signal ? { signal, passive: true } : { passive: true },
    );
    if (window.visualViewport) {
      const onViewport = () => {
        const vv = window.visualViewport;
        if (!vv) return;
        const imeOffset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        root.style.setProperty('--ime-inset-bottom', `${Math.round(imeOffset)}px`);
      };
      window.visualViewport.addEventListener(
        'resize',
        onViewport,
        signal ? { signal, passive: true } : { passive: true },
      );
    }
  }
  return initial;
}
