import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../../src/ui/debounce';
import {
  applyActiveNav,
  isMobileSecondaryRoute,
  isNavRouteId,
  MOBILE_PRIMARY_ROUTES,
  MOBILE_SECONDARY_ROUTES,
  NAV_DOMAIN_IDS,
  NAV_ROUTE_LABELS,
} from '../../src/ui/nav';
import { inlineSkeleton, panelSkeleton } from '../../src/ui/skeleton';

type AttrMap = Map<string, string>;

class TestNode {
  readonly nodeType = 1;
  className = '';
  textContent = '';
  readonly children: TestNode[] = [];
  readonly dataset: Record<string, string> = {};
  private readonly attrs: AttrMap = new Map();
  classList = {
    toggle: (token: string, force?: boolean) => {
      const parts = new Set(this.className.split(/\s+/).filter(Boolean));
      const on = force === undefined ? !parts.has(token) : force;
      if (on) parts.add(token);
      else parts.delete(token);
      this.className = [...parts].join(' ');
      return on;
    },
    contains: (token: string) => this.className.split(/\s+/).includes(token),
  };

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      delete this.dataset[key];
    }
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force === undefined ? !this.attrs.has(name) : force;
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return on;
  }

  append(...nodes: TestNode[]): void {
    this.children.push(...nodes);
  }

  querySelector(selector: string): TestNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): TestNode[] {
    const out: TestNode[] = [];
    const visit = (node: TestNode) => {
      if (matches(node, selector)) out.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return out;
  }
}

function matches(node: TestNode, selector: string): boolean {
  if (selector.startsWith('#')) return node.getAttribute('id') === selector.slice(1);
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const body = selector.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq === -1) return node.hasAttribute(body);
    const key = body.slice(0, eq);
    const raw = body.slice(eq + 1).replace(/^["']|["']$/g, '');
    return node.getAttribute(key) === raw;
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

type TestDocument = {
  body: TestNode;
  createElement: (tag: string) => TestNode;
  querySelector: (sel: string) => TestNode | null;
  querySelectorAll: (sel: string) => TestNode[];
};

function installTestDocument(): void {
  const body = new TestNode('body');
  const doc: TestDocument = {
    body,
    createElement: (tag: string) => new TestNode(tag),
    querySelector: (sel: string) => body.querySelector(sel),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
  };
  (globalThis as unknown as { document: TestDocument }).document = doc;
}

function clearTestDocument(): void {
  Reflect.deleteProperty(globalThis, 'document');
}

describe('Phase 1 nav domain map', () => {
  it('covers the 14-domain map with typed route labels', () => {
    expect(NAV_DOMAIN_IDS).toHaveLength(14);
    expect(NAV_DOMAIN_IDS).toContain('search');
    expect(Object.keys(NAV_ROUTE_LABELS)).toHaveLength(13);
    expect(NAV_ROUTE_LABELS.saved).toBe('My List');
    expect(NAV_ROUTE_LABELS.reviews).toBe('Review Deck');
    expect(NAV_ROUTE_LABELS.paths).toBe('Roadmaps');
    expect(isNavRouteId('library')).toBe(true);
    expect(isNavRouteId('search')).toBe(false);
    expect(MOBILE_PRIMARY_ROUTES).toEqual(['home', 'courses', 'saved', 'planner', 'tutor']);
    expect(MOBILE_SECONDARY_ROUTES).toContain('admin');
    expect(isMobileSecondaryRoute('history')).toBe(true);
    expect(isMobileSecondaryRoute('home')).toBe(false);
  });
});

describe('applyActiveNav', () => {
  beforeEach(() => {
    installTestDocument();
    const root = document.body as unknown as TestNode;
    const crumbSec = new TestNode('div');
    crumbSec.setAttribute('id', 'crumb-section');
    crumbSec.textContent = 'Discovery';
    const crumbCur = new TestNode('div');
    crumbCur.setAttribute('id', 'crumb-current');
    crumbCur.textContent = 'Catalog';
    const nav = new TestNode('nav');
    nav.setAttribute('id', 'primary-nav');
    for (const [view, label] of [
      ['home', 'Home'],
      ['library', 'Library'],
      ['tutor', 'AI Tutor'],
    ] as const) {
      const btn = new TestNode('button');
      btn.setAttribute('data-catalog-view', view);
      btn.className = 'lms-nav-item';
      const span = new TestNode('span');
      span.className = 'lms-nav-label';
      span.textContent = label;
      btn.append(span);
      nav.append(btn);
    }
    const more = new TestNode('button');
    more.setAttribute('id', 'mobile-more-btn');
    more.className = 'lms-nav-item mobile-more-trigger';
    nav.append(more);
    root.append(crumbSec, crumbCur, nav);
  });

  afterEach(() => {
    clearTestDocument();
  });

  it('marks the matching route with aria-current and .active', () => {
    applyActiveNav('tutor');
    const home = document.querySelector('[data-catalog-view="home"]') as unknown as TestNode;
    const tutor = document.querySelector('[data-catalog-view="tutor"]') as unknown as TestNode;
    const more = document.querySelector('#mobile-more-btn') as unknown as TestNode;
    expect(tutor.getAttribute('aria-current')).toBe('page');
    expect(tutor.classList.contains('active')).toBe(true);
    expect(home.hasAttribute('aria-current')).toBe(false);
    expect(home.classList.contains('active')).toBe(false);
    expect(more.classList.contains('active')).toBe(false);
    expect(more.hasAttribute('aria-current')).toBe(false);
    expect((document.querySelector('#crumb-section') as unknown as TestNode).textContent).toBe('Studio');
    expect((document.querySelector('#crumb-current') as unknown as TestNode).textContent).toBe('AI Study Partner');
  });

  it('visually activates Menu for secondary mobile routes without dual aria-current', () => {
    applyActiveNav('library');
    const library = document.querySelector('[data-catalog-view="library"]') as unknown as TestNode;
    const more = document.querySelector('#mobile-more-btn') as unknown as TestNode;
    expect(library.getAttribute('aria-current')).toBe('page');
    expect(more.classList.contains('active')).toBe(true);
    expect(more.getAttribute('data-active-route')).toBe('');
    expect(more.hasAttribute('aria-current')).toBe(false);
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses rapid calls into one invocation after the wait', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 180);
    debounced('a');
    debounced('b');
    debounced('c');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(179);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('cancel prevents a pending call; flush runs immediately', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('pending');
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    debounced.flush('now');
    expect(fn).toHaveBeenCalledWith('now');
  });
});

describe('panelSkeleton helpers', () => {
  beforeEach(() => {
    installTestDocument();
  });

  afterEach(() => {
    clearTestDocument();
  });

  it('builds accessible panel / cards / lines / history skeletons', () => {
    const panel = panelSkeleton({ variant: 'panel', count: 2, label: 'Loading reviews…' }) as unknown as TestNode;
    expect(panel.getAttribute('role')).toBe('status');
    expect(panel.getAttribute('aria-busy')).toBe('true');
    expect(panel.children.find(c => c.className === 'cf-skeleton-label')?.textContent).toBe('Loading reviews…');
    expect(panel.children.flatMap(walkBlocks).filter(c => c.className.includes('cf-skeleton-block'))).toHaveLength(2);

    const cards = panelSkeleton({ variant: 'cards', count: 3 }) as unknown as TestNode;
    expect(cards.className).toContain('course-grid');
    expect(cards.children.filter(c => c.className.includes('course-skeleton'))).toHaveLength(3);

    const history = panelSkeleton({ variant: 'history', count: 2 }) as unknown as TestNode;
    expect(history.className).toContain('history-grid');
    expect(history.children.filter(c => c.className.includes('history-card-skeleton'))).toHaveLength(2);

    const lines = inlineSkeleton('Loading prefs…') as unknown as TestNode;
    expect(lines.className).toContain('cf-panel-skeleton--inline');
    expect(lines.children.filter(c => c.className.includes('cf-skeleton-line')).length).toBeGreaterThanOrEqual(3);
  });
});

function walkBlocks(node: TestNode): TestNode[] {
  return [node, ...node.children.flatMap(walkBlocks)];
}
