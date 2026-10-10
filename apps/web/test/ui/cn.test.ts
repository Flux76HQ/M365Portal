// `cn` knows the utility names of OUR theme (lib/cn.ts, styles/app.css). The default tables of the
// `cn` package would treat `text-body` as a text colour and drop it next to `text-fg`; this test
// pins the behaviour that components rely on when they let a caller's `className` win.
import { cn as defaultCn } from 'cn';
import { describe, expect, it } from 'vitest';
import { cn } from '../../src/lib/cn';

describe('cn with the theme of this application', () => {
  it.each([
    [
      'a type size and a text colour are different things',
      ['text-body', 'text-fg'],
      'text-body text-fg',
    ],
    ['two type sizes conflict, the last wins', ['text-body', 'text-title-1'], 'text-title-1'],
    ['every type size is known', ['text-caption', 'text-display'], 'text-display'],
    ['two text colours conflict', ['text-fg', 'text-danger'], 'text-danger'],
    ['two shadow levels conflict', ['shadow-1', 'shadow-3'], 'shadow-3'],
    [
      'a shadow level and a shadow colour are different things',
      ['shadow-1', 'shadow-danger'],
      'shadow-1 shadow-danger',
    ],
    [
      'two font weights conflict (regular is ours)',
      ['font-regular', 'font-semibold'],
      'font-semibold',
    ],
    ['two layers conflict', ['z-menu', 'z-dialog'], 'z-dialog'],
    ['two durations conflict', ['duration-fast', 'duration-slow'], 'duration-slow'],
    ['two easings conflict', ['ease-standard', 'ease-spring'], 'ease-spring'],
    ['control height conflicts with a spacing height', ['h-control', 'h-8'], 'h-8'],
    ['a minimum target conflicts with a spacing minimum', ['min-h-target', 'min-h-10'], 'min-h-10'],
    ['two surfaces conflict', ['bg-surface-page', 'bg-accent'], 'bg-accent'],
    ['two radii conflict', ['rounded-md', 'rounded-lg'], 'rounded-lg'],
    ['spacing on the grid conflicts', ['p-4', 'p-2'], 'p-2'],
    [
      'a variant keeps its own group',
      ['hover:bg-accent-hover', 'bg-accent'],
      'hover:bg-accent-hover bg-accent',
    ],
    ['max-w-content is a width cap', ['max-w-content', 'max-w-sm'], 'max-w-sm'],
  ])('%s', (_label, inputs, expected) => {
    expect(cn(...inputs)).toBe(expected);
  });

  it('joins like clsx: conditionals, arrays and objects', () => {
    const flag = (value: boolean): boolean => value;
    const active = flag(true);
    const inactive = flag(false);
    expect(
      cn('px-2', inactive && 'px-4', active && 'py-2', ['gap-2'], { 'font-medium': active }),
    ).toBe('px-2 py-2 gap-2 font-medium');
  });

  it('lets the caller win over the component default', () => {
    expect(cn('bg-accent text-on-accent h-control', 'bg-surface-raised')).toBe(
      'text-on-accent h-control bg-surface-raised',
    );
  });

  it('negative control: the default tables drop a theme class, so the configuration is needed', () => {
    expect(defaultCn('text-body', 'text-fg')).toBe('text-fg');
    expect(defaultCn('shadow-1', 'shadow-danger')).toBe('shadow-danger');
    expect(defaultCn('z-menu', 'z-dialog')).toBe('z-menu z-dialog');
  });
});
