import type { Course, Lesson } from '../contracts';
import { ContractError, parseLesson } from '../validation';

export interface SavedItem {
  id: string;
  item_type: 'course' | 'lecture';
  course_id: string;
  title: string;
}
export interface ContinueItem extends Lesson {
  position: number;
  percent: number;
  completed: boolean;
}
export interface TrendingItem {
  rank: number;
  lesson_id: string;
  title: string;
  course_id: string;
  duration_seconds: number;
  viewers: number;
}
export interface HomeFeedRow {
  id: string;
  title: string;
  kind: string;
  items: unknown;
}
export interface HomeFeed {
  hero: Course[];
  rows: HomeFeedRow[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('discovery response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new ContractError('saved item');
  return value;
}
export function parseSaved(value: unknown): { items: SavedItem[]; next_cursor: string | null } {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > 100) throw new ContractError('saved list');
  return {
    items: data.items.map(raw => {
      const item = object(raw);
      if (item.item_type !== 'course' && item.item_type !== 'lecture') throw new ContractError('saved item type');
      return { id: text(item.id), item_type: item.item_type, course_id: text(item.course_id), title: text(item.title) };
    }),
    next_cursor: typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null,
  };
}
export function parseContinued(value: unknown): ContinueItem[] {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > 15) throw new ContractError('continue learning');
  return data.items.map(raw => {
    const item = object(raw);
    if (
      typeof item.position !== 'number' ||
      !Number.isFinite(item.position) ||
      item.position < 0 ||
      typeof item.percent !== 'number' ||
      !Number.isFinite(item.percent) ||
      item.percent < 0 ||
      item.percent > 100 ||
      typeof item.completed !== 'boolean'
    )
      throw new ContractError('learning progress');
    return { ...parseLesson(item), position: item.position, percent: item.percent, completed: item.completed };
  });
}
export function courseCover(course: Course): string | null {
  if (!course.cover_url) return null;
  try {
    const url = new URL(course.cover_url, 'https://courseforge.invalid');
    return url.origin === 'https://courseforge.invalid' &&
      url.pathname.startsWith('/api/v1/courses/') &&
      url.pathname.endsWith('/cover')
      ? `${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}
export function parseTrending(value: unknown): TrendingItem[] {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > 15) throw new ContractError('trending list');
  return data.items.map(raw => {
    const item = object(raw);
    if (
      typeof item.rank !== 'number' ||
      !Number.isInteger(item.rank) ||
      item.rank < 1 ||
      item.rank > 10 ||
      typeof item.viewers !== 'number' ||
      !Number.isFinite(item.viewers) ||
      item.viewers < 1 ||
      typeof item.duration_seconds !== 'number' ||
      !Number.isFinite(item.duration_seconds) ||
      item.duration_seconds < 0
    )
      throw new ContractError('trending item');
    return {
      rank: item.rank,
      lesson_id: text(item.lesson_id),
      title: text(item.title),
      course_id: text(item.course_id),
      duration_seconds: item.duration_seconds,
      viewers: item.viewers,
    };
  });
}
export function parseHomeFeed(value: unknown): HomeFeed {
  const data = object(value);
  if (!Array.isArray(data.hero) || data.hero.length > 10) throw new ContractError('home feed hero');
  if (!Array.isArray(data.rows) || data.rows.length > 20) throw new ContractError('home feed rows');
  const rows = data.rows.map(raw => {
    const row = object(raw);
    const id = text(row.id);
    const title = text(row.title);
    const kind = text(row.kind);
    if (kind === 'rank_card' && id !== 'trending-top-10') throw new ContractError('ranked row id');
    return { id, title, kind, items: row.items };
  });
  // Ranked chrome is only valid when the row claims measured trending items.
  for (const row of rows) {
    if (row.kind !== 'rank_card') continue;
    const ranked = parseTrending({ items: row.items });
    if (!ranked.length) throw new ContractError('empty ranked row');
  }
  return {
    hero: data.hero.map(item => {
      const course = object(item);
      return {
        id: text(course.id),
        title: text(course.title),
        ...(typeof course.description === 'string' ? { description: course.description } : {}),
        ...(typeof course.cover_url === 'string' ? { cover_url: course.cover_url } : {}),
        ...(typeof course.category === 'string' ? { category: course.category } : {}),
        ...(typeof course.instructor === 'string' ? { instructor: course.instructor } : {}),
        ...(typeof course.lesson_count === 'number' ? { lesson_count: course.lesson_count } : {}),
        ...(typeof course.duration_seconds === 'number' ? { duration_seconds: course.duration_seconds } : {}),
        ...(typeof course.enrolled === 'boolean' ? { enrolled: course.enrolled } : {}),
        ...(Array.isArray(course.tags) ? { tags: course.tags.filter((t): t is string => typeof t === 'string') } : {}),
      };
    }),
    rows,
  };
}
/** Measured trending items only — rejects fabricated zero-viewer ranks. */
export function measuredTrending(items: TrendingItem[]): TrendingItem[] {
  return items.filter(item => item.viewers >= 1 && item.rank >= 1 && item.rank <= 10).slice(0, 10);
}

function parseCourseCardList(items: unknown): Course[] {
  if (!Array.isArray(items) || items.length > 50) return [];
  const out: Course[] = [];
  for (const raw of items) {
    try {
      const course = object(raw);
      out.push({
        id: text(course.id),
        title: text(course.title),
        ...(typeof course.description === 'string' ? { description: course.description } : {}),
        ...(typeof course.cover_url === 'string' ? { cover_url: course.cover_url } : {}),
        ...(typeof course.category === 'string' ? { category: course.category } : {}),
        ...(typeof course.instructor === 'string' ? { instructor: course.instructor } : {}),
        ...(typeof course.lesson_count === 'number' ? { lesson_count: course.lesson_count } : {}),
        ...(typeof course.duration_seconds === 'number' ? { duration_seconds: course.duration_seconds } : {}),
        ...(typeof course.enrolled === 'boolean' ? { enrolled: course.enrolled } : {}),
        ...(Array.isArray(course.tags)
          ? { tags: course.tags.filter((t): t is string => typeof t === 'string') }
          : {}),
      });
    } catch {
      /* Skip malformed cards — never invent catalog entries. */
    }
  }
  return out;
}

/** Pull personal discovery rows from a measured home-feed response. */
export function personalRowsFromHomeFeed(feed: HomeFeed): {
  continued: ContinueItem[];
  saved: SavedItem[];
  trending: TrendingItem[];
  forYou: Course[];
  featured: Course[];
} {
  let continued: ContinueItem[] = [];
  let saved: SavedItem[] = [];
  let trending: TrendingItem[] = [];
  let forYou: Course[] = [];
  let featured: Course[] = [];
  for (const row of feed.rows) {
    if (row.id === 'continue-watching' || row.kind === 'lecture_card') {
      try {
        continued = parseContinued({ items: row.items });
      } catch {
        /* Keep prior empty — never invent resume positions. */
      }
    }
    if (row.id === 'my-list' || row.kind === 'saved_card') {
      try {
        saved = parseSaved({ items: row.items, next_cursor: '' }).items;
      } catch {
        /* Keep prior empty. */
      }
    }
    if (row.id === 'trending-top-10' || row.kind === 'rank_card') {
      try {
        trending = measuredTrending(parseTrending({ items: row.items }));
      } catch {
        /* Rank chrome stays empty without measured viewers. */
      }
    }
    if (row.id === 'for-you' || (row.kind === 'course_card' && row.id === 'for-you')) {
      forYou = parseCourseCardList(row.items);
    }
    if (row.id === 'featured-titles' || (row.kind === 'course_card' && row.id === 'featured-titles')) {
      featured = parseCourseCardList(row.items);
    }
  }
  return { continued, saved, trending, forYou, featured };
}

/** Prefer authenticated home-feed hero cards; fall back to first featured title. */
export function heroFromHomeFeed(feed: HomeFeed): Course | null {
  if (feed.hero.length > 0) return feed.hero[0] ?? null;
  const { featured, forYou } = personalRowsFromHomeFeed(feed);
  return forYou[0] ?? featured[0] ?? null;
}

/** Seed catalog cards from home-feed course rows without inventing IDs. */
export function catalogSeedFromHomeFeed(feed: HomeFeed): Course[] {
  const { forYou, featured } = personalRowsFromHomeFeed(feed);
  const byId = new Map<string, Course>();
  for (const course of [...feed.hero, ...forYou, ...featured]) {
    if (!byId.has(course.id)) byId.set(course.id, course);
  }
  return [...byId.values()];
}
