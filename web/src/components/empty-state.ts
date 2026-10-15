import type { IconName } from '../icons';
import { svgIcon } from '../icons';
import { el } from './dom';

export interface EmptyStateOptions {
  className?: string;
  icon?: IconName;
  title: string;
  description?: string;
  action?: HTMLElement;
}

export function emptyState(options: EmptyStateOptions): HTMLElement {
  const node = el('div', options.className ?? 'catalog-empty');
  if (options.icon) {
    const iconWrap = el('span', 'empty-symbol');
    iconWrap.append(svgIcon(options.icon));
    node.append(iconWrap);
  }
  node.append(el('h2', '', options.title));
  if (options.description) node.append(el('p', 'muted', options.description));
  if (options.action) node.append(options.action);
  return node;
}
