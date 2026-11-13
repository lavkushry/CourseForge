/**
 * Shared 14-domain navigation contracts for the LMS shell.
 * Keeps rail / Academy Studio / mobile bottom-nav active state in sync.
 */

export const NAV_DOMAIN_IDS = [
  'search',
  'home',
  'courses',
  'saved',
  'library',
  'planner',
  'history',
  'reviews',
  'tutor',
  'labs',
  'paths',
  'career',
  'settings',
  'admin',
] as const;

export type NavDomainId = (typeof NAV_DOMAIN_IDS)[number];

/** Routed workspace views (Search opens OmniSearch; it is not a panel). */
export type NavRouteId = Exclude<NavDomainId, 'search'>;

export const NAV_ROUTE_LABELS: Record<NavRouteId, string> = {
  home: 'Home',
  courses: 'Courses',
  saved: 'My List',
  library: 'Library',
  planner: 'Daily Plan',
  history: 'History',
  reviews: 'Review Deck',
  tutor: 'AI Tutor',
  labs: 'Labs',
  paths: 'Roadmaps',
  career: 'Career',
  settings: 'Settings',
  admin: 'Admin',
};

/** Thumb-zone dock shows these; everything else lives under Menu. */
export const MOBILE_PRIMARY_ROUTES: readonly NavRouteId[] = [
  'home',
  'courses',
  'saved',
  'planner',
  'tutor',
] as const;

export const MOBILE_SECONDARY_ROUTES: readonly NavRouteId[] = [
  'library',
  'history',
  'paths',
  'reviews',
  'labs',
  'career',
  'settings',
  'admin',
] as const;

export const NAV_CRUMBS: Record<NavRouteId, readonly [string, string]> = {
  home: ['Discovery', '2026 Masterclass Catalog'],
  courses: ['Courses', 'All Engineering Tracks'],
  saved: ['Courses', 'My Saved List'],
  library: ['Workspace', 'Course Library'],
  planner: ['Workspace', 'Daily Plan & Schedule'],
  history: ['Workspace', 'Watch History'],
  reviews: ['Studio', 'Spaced Repetition Deck'],
  tutor: ['Studio', 'AI Study Partner'],
  labs: ['Studio', 'Cloud IDE Labs'],
  paths: ['Studio', 'Learning Roadmaps'],
  career: ['Studio', 'Career & Resume'],
  settings: ['Studio', 'Studio Settings'],
  admin: ['Studio', 'Command Center'],
};

export function isNavRouteId(value: string): value is NavRouteId {
  return value !== 'search' && (NAV_DOMAIN_IDS as readonly string[]).includes(value);
}

export function isMobileSecondaryRoute(view: string): boolean {
  return (MOBILE_SECONDARY_ROUTES as readonly string[]).includes(view);
}

/**
 * Sync aria-current + .active across every [data-catalog-view] control and the
 * mobile Menu trigger when the active route is docked under "More".
 */
export function applyActiveNav(view: string, root: ParentNode = document): void {
  const route = isNavRouteId(view) ? view : '';
  for (const link of root.querySelectorAll('[data-catalog-view]')) {
    const match = route !== '' && link.getAttribute('data-catalog-view') === route;
    link.classList.toggle('active', match);
    if (match) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  const more = root.querySelector('#mobile-more-btn');
  if (more) {
    // Visual only: keep a single aria-current on the real route control.
    const secondary = route !== '' && isMobileSecondaryRoute(route);
    more.classList.toggle('active', secondary);
    more.toggleAttribute('data-active-route', secondary);
    more.removeAttribute('aria-current');
  }

  if (!route) return;
  const crumbs = NAV_CRUMBS[route];
  const crumbSec = root.querySelector('#crumb-section');
  const crumbCur = root.querySelector('#crumb-current');
  if (crumbSec) crumbSec.textContent = crumbs[0];
  if (crumbCur) crumbCur.textContent = crumbs[1];
}
