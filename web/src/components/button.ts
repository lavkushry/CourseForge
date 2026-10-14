import type { IconName } from '../icons';
import { svgIcon } from '../icons';
import { el } from './dom';

export interface ButtonOptions {
  className?: string;
  icon?: IconName;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  title?: string;
  id?: string;
}

export function button(
  text: string,
  action: () => void,
  classNameOrOptions: string | ButtonOptions = 'button',
): HTMLButtonElement {
  const options: ButtonOptions =
    typeof classNameOrOptions === 'string' ? { className: classNameOrOptions } : classNameOrOptions;
  const node = el('button', options.className ?? 'button');
  node.type = options.type ?? 'button';
  if (options.id) node.id = options.id;
  if (options.title) node.title = options.title;
  if (options.disabled) node.disabled = true;
  if (options.icon) {
    node.append(svgIcon(options.icon), el('span', '', text));
  } else {
    node.textContent = text;
  }
  node.addEventListener('click', action);
  return node;
}
