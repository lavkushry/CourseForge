import { el } from './dom';

export interface PillOptions {
  className?: string;
  tone?: 'default' | 'terracotta' | 'purple' | 'emerald' | 'ocean';
}

const toneClass: Record<NonNullable<PillOptions['tone']>, string> = {
  default: '',
  terracotta: 'pill-terracotta',
  purple: 'pill-purple',
  emerald: 'pill-emerald',
  ocean: 'pill-ocean',
};

export function pill(text: string, options: PillOptions = {}): HTMLElement {
  const classes = ['lesson-badge-pill', options.className, options.tone ? toneClass[options.tone] : '']
    .filter(Boolean)
    .join(' ');
  return el('span', classes || 'lesson-badge-pill', text);
}
