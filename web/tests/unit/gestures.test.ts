import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const gestures = readFileSync(join(root, 'player/gestures.ts'), 'utf8');
const shell = readFileSync(join(root, 'app/shell.ts'), 'utf8');

describe('player gestures concentration', () => {
  it('prefers dismissing an open study sheet over toggling play on single tap', () => {
    expect(gestures).toContain('closeStudy?: () => boolean');
    expect(gestures).toContain('if (actions.closeStudy?.()) return;');
    expect(gestures).toContain('Prefer returning to the lesson');
    expect(shell).toContain('closeStudy: () => {');
    expect(shell).toMatch(/dock-collapsed.*drawer-collapsed.*sheet-compact/s);
  });
});
