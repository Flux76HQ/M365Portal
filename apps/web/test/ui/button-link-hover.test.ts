// @vitest-environment node
/// <reference types="node" />
//
// THE HOVER COLOUR OF THE LINK BUTTON (chunk-s4c OP-2).
//
// `accent-hover` is derived for a FILL with the on-accent colour on it (a step in the direction that
// raises contrast with white or black text). Used as TEXT on the page surface it is lighter than the
// accent in the dark theme and failed axe color-contrast there. The text role is `accent-text`, which
// shared/accent.property.test.ts guarantees at 4.5:1 on all four surfaces and on `accent-subtle` for
// every accent, in both themes. So the link keeps `accent-text` while hovered and shows the hover with
// the subtle fill and a thicker underline, never with `accent-hover`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buttonVariants } from '../../src/components/ui/button';

const here = dirname(fileURLToPath(import.meta.url));

function classes(variant: 'link' | 'primary') {
  return buttonVariants({ variant, size: 'default' }).split(/\s+/);
}

describe('link button hover', () => {
  it('never uses accent-hover as a text colour', () => {
    expect(classes('link').filter((c) => c.includes('text-accent-hover'))).toEqual([]);
  });

  it('keeps accent-text on hover, over the guaranteed accent-subtle fill', () => {
    const link = classes('link');
    expect(link).toContain('text-accent-text');
    expect(link).toContain('hover:bg-accent-subtle');
    expect(link.some((c) => c.startsWith('hover:text-') && c !== 'hover:text-accent-text')).toBe(
      false,
    );
    expect(link).toContain('hover:decoration-2');
  });

  it('is still the fill colour accent-hover that the primary button uses', () => {
    expect(classes('primary')).toContain('hover:bg-accent-hover');
  });

  it('is shown in its forced hover state in the showcase (no omission)', () => {
    const source = readFileSync(
      join(here, '../../src/features/showcase/ControlsSection.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/filter\(\(variant\) => variant !== 'link'\)/);
    expect(source).not.toMatch(/link:\s*'text-accent-hover'/);
    expect(source).toMatch(/link:\s*'[^']*bg-accent-subtle/);
  });
});
