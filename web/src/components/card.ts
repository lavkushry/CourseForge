import { el } from './dom';

export interface CardOptions {
  className?: string;
  title?: string;
  subtitle?: string;
  body?: HTMLElement | string;
  actions?: HTMLElement[];
}

export function card(options: CardOptions = {}): HTMLElement {
  const node = el('article', options.className ?? 'cf-card');
  if (options.title) {
    const head = el('div', 'cf-card-head');
    head.append(el('h3', 'cf-card-title', options.title));
    if (options.subtitle) head.append(el('p', 'muted cf-card-subtitle', options.subtitle));
    node.append(head);
  }
  if (typeof options.body === 'string') {
    node.append(el('div', 'cf-card-body', options.body));
  } else if (options.body) {
    const body = el('div', 'cf-card-body');
    body.append(options.body);
    node.append(body);
  }
  if (options.actions?.length) {
    const actions = el('div', 'cf-card-actions');
    actions.append(...options.actions);
    node.append(actions);
  }
  return node;
}
