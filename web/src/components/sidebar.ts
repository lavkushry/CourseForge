import { el } from './dom';

export interface SidebarOptions {
  id?: string;
  className?: string;
  label?: string;
  title?: string;
  children?: HTMLElement[];
}

export function sidebar(options: SidebarOptions = {}): HTMLElement {
  const node = el('aside', options.className ?? 'cf-sidebar');
  if (options.id) node.id = options.id;
  if (options.label) node.setAttribute('aria-label', options.label);
  if (options.title) node.append(el('h2', '', options.title));
  if (options.children?.length) node.append(...options.children);
  return node;
}
