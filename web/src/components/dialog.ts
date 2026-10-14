import { button } from './button';
import { el } from './dom';

export interface DialogOptions {
  id?: string;
  className?: string;
  title: string;
  subtitle?: string;
  body?: HTMLElement;
  onClose?: () => void;
  labelledBy?: string;
}

export function dialog(options: DialogOptions): HTMLDialogElement {
  const node = el('dialog', options.className ?? 'cf-dialog');
  if (options.id) node.id = options.id;
  const headingId = options.labelledBy ?? `${options.id ?? 'dialog'}-heading`;
  node.setAttribute('aria-labelledby', headingId);

  const heading = el('div', 'dialog-heading');
  const titleGroup = el('div', 'dialog-title-group');
  titleGroup.append(el('h2', '', options.title));
  titleGroup.querySelector('h2')!.id = headingId;
  if (options.subtitle) {
    titleGroup.append(el('span', 'dialog-subtitle-badge', options.subtitle));
  }
  const closeBtn = button('Close', () => {
    options.onClose?.();
    if (typeof node.close === 'function') node.close();
  }, 'button quiet close-drawer-btn');
  heading.append(titleGroup, closeBtn);
  node.append(heading);
  if (options.body) node.append(options.body);
  return node;
}
