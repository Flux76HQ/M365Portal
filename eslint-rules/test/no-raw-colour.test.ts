// local/no-raw-colour (FR-A-009): no raw colour literal and no Tailwind arbitrary colour value in
// the web package's TypeScript. Components consume design tokens (AGENTS.md section 6).
//
// The patterns mirror the source scan in packages/shared/test/repo-conventions.test.ts (check 4),
// which also reads CSS; this rule is the precise control for strings and template literals in code.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

const FILE = 'apps/web/src/components/Swatch.tsx';
const rule = ruleOf('no-raw-colour');

function validCase(code: string, name?: string): RuleTester.ValidTestCase {
  return { name: name ?? code, code, filename: FILE };
}

function raw(code: string, kind: string, shown: string, name?: string): RuleTester.InvalidTestCase {
  return {
    name: name ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'rawColour', data: { kind, text: shown } }],
  };
}

createRuleTester().run('local/no-raw-colour', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    // Tokens and ordinary strings.
    validCase("const a = 'bg-surface text-fg border-border';", 'token utilities'),
    validCase("const a = 'var(--accent)';", 'a custom property reference'),
    validCase("const a = 'bg-accent/20 text-on-accent';", 'opacity modifier on a token'),
    validCase(
      "const a = <div className='bg-(--surface) text-(--fg)' />;",
      'Tailwind variable shorthand',
    ),
    validCase("const a = 'transparent';"),
    validCase("const a = 'currentColor';"),
    validCase('const a = `${base} bg-surface`;', 'template with a token'),
    validCase(
      "const a = 'rounded-[6px] w-[calc(100%-2rem)] grid-cols-[auto_1fr]';",
      'arbitrary non-colour values',
    ),
    validCase(
      "const a = 'bg-[length:10px_10px] text-[length:var(--size)]';",
      'arbitrary length hints',
    ),

    // Things that merely look like a colour.
    validCase(
      "const a = ['/#main-content', '#root', '#fff1a', 'a#cafe0'];",
      'anchors, ids, hex-looking words',
    ),
    validCase("const a = 'a&#169;b';", 'numeric entity'),
    validCase("const a = 'url(#clip)';", 'url fragment reference'),
    validCase("const a = 'getcolor(1)';", 'function name that ends in colour'),
    validCase("const a = 'rgbish(1)';", 'near miss on the function name'),
    validCase("const a = 'color(1)';", 'color( without a colour space'),
    validCase("const a = '#12345';", 'five hex digits is not a colour'),
    validCase("const a = '#1234567';", 'seven hex digits is not a colour'),
    validCase("const a = '#ggg';", 'not hex digits'),
    validCase("const a = 'item-#fff-1';", 'preceded by a hyphen and followed by one'),
    validCase("const a = 'ab#fff';", 'preceded by a letter'),
    validCase("const a = '#fffg';", 'followed by a letter'),
    validCase("const a = 'bg-[length:red]';", 'the word red is not in a colour position'),
    validCase('const a = /#fff/;', 'a regular expression literal is not a string'),

    // Not strings.
    validCase('// was #123456 and rgb(1, 2, 3)\nconst a = 1;', 'a line comment'),
    validCase('/* #abcdef */ const a = 1;', 'a block comment'),
    validCase('const a = <p>#fff</p>;', 'JSX text is a literal-string matter, not a colour one'),
    validCase('const rgb = 1; const hex = rgb + 2;', 'identifiers'),
  ],

  invalid: [
    // Hex.
    raw("const a = '#fff';", 'hex colour', '#fff'),
    raw("const a = '#ffff';", 'hex colour', '#ffff', 'four digits (with alpha)'),
    raw("const a = '#1a2b3c';", 'hex colour', '#1a2b3c'),
    raw("const a = '#1A2B3CDD';", 'hex colour', '#1A2B3CDD', 'eight digits (with alpha)'),
    raw("const a = 'color: #ff0000;';", 'hex colour', '#ff0000', 'inside a declaration'),
    raw("const a = 'linear-gradient(#fff, #000)';", 'hex colour', '#fff', 'first of several'),
    raw(
      'const a = `border: 1px solid #ccc`;',
      'hex colour',
      '#ccc',
      'template literal without expressions',
    ),
    raw(
      'const a = `${width}px solid #ccc`;',
      'hex colour',
      '#ccc',
      'template literal with an expression',
    ),
    raw("const a = <div style={{ color: '#f00' }} />;", 'hex colour', '#f00', 'inline style value'),
    raw("const a = <div fill='#abc' />;", 'hex colour', '#abc', 'JSX attribute string'),
    raw("const a = { '#fff': 1 };", 'hex colour', '#fff', 'property key'),
    raw('const a = tag`color: #fff`;', 'hex colour', '#fff', 'tagged template'),

    // Colour functions.
    raw("const a = 'rgb(0, 0, 0)';", 'colour function', 'rgb('),
    raw("const a = 'rgba(0 0 0 / 50%)';", 'colour function', 'rgba('),
    raw("const a = 'hsl(210 40% 96%)';", 'colour function', 'hsl('),
    raw("const a = 'hsla(210, 40%, 96%, 0.5)';", 'colour function', 'hsla('),
    raw("const a = 'hwb(194 0% 0%)';", 'colour function', 'hwb('),
    raw("const a = 'oklch(0.7 0.1 250)';", 'colour function', 'oklch('),
    raw("const a = 'oklab(0.7 0.1 0.1)';", 'colour function', 'oklab('),
    raw("const a = 'lab(50% 40 59.5)';", 'colour function', 'lab('),
    raw("const a = 'lch(50% 80 30)';", 'colour function', 'lch('),
    raw(
      "const a = 'color-mix(in oklab, var(--accent) 20%, transparent)';",
      'colour function',
      'color-mix(',
    ),
    raw("const a = 'RGB(1, 2, 3)';", 'colour function', 'RGB(', 'upper case'),
    raw("const a = 'color(display-p3 1 0 0)';", 'colour() with a colour space', 'color(display-p3'),
    raw(
      "const a = 'color( srgb 1 0 0)';",
      'colour() with a colour space',
      'color( srgb',
      'with a space',
    ),

    // Tailwind arbitrary colour values.
    raw("const a = 'bg-[#fff]';", 'hex colour', '#fff', 'arbitrary hex'),
    raw(
      "const a = 'text-[rgb(1,2,3)]';",
      'Tailwind arbitrary colour value',
      '-[rgb(',
      'arbitrary function',
    ),
    raw("const a = 'border-[oklch(0.5_0.1_20)]';", 'Tailwind arbitrary colour value', '-[oklch('),
    raw("const a = 'bg-[color:var(--brand)]';", 'Tailwind arbitrary colour value', '-[color:'),
    raw("const a = 'shadow-[0_0_0_1px_#000]';", 'hex colour', '#000', 'colour inside a shadow'),
    raw(
      "const a = 'shadow-[0_0_#000_inset]';",
      'hex colour',
      '#000',
      'underscores are Tailwind spaces',
    ),
    raw(
      "const a = 'shadow-[0_0_0_1px_rgb(0,0,0)]';",
      'colour function',
      'rgb(',
      'function after an underscore',
    ),
    raw("const a = 'bg-[red]';", 'Tailwind arbitrary colour value', '-[red]', 'a named colour'),
    raw(
      "const a = 'bg-[#fff] text-[red]';",
      'Tailwind arbitrary colour value',
      '-[red]',
      'one report per literal: the Tailwind pattern is tried first',
    ),
    raw("const a = 'text-[RebeccaPurple]';", 'Tailwind arbitrary colour value', '-[RebeccaPurple]'),
    raw("const a = 'fill-[color:red]';", 'Tailwind arbitrary colour value', '-[color:'),
    raw(
      "const a = <div className='flex bg-[#0f0] p-2' />;",
      'hex colour',
      '#0f0',
      'among other classes',
    ),
    raw(
      "const a = cn('p-2', open && 'bg-[#0f0]');",
      'hex colour',
      '#0f0',
      'argument of a class helper',
    ),

    {
      name: 'every offending literal is reported, once each',
      code: "const a = ['#fff', 'rgb(0,0,0)', `x ${b} #000`];",
      filename: FILE,
      errors: [
        { messageId: 'rawColour', data: { kind: 'hex colour', text: '#fff' } },
        { messageId: 'rawColour', data: { kind: 'colour function', text: 'rgb(' } },
        { messageId: 'rawColour', data: { kind: 'hex colour', text: '#000' } },
      ],
    },
    {
      name: 'reports the position of the literal',
      code: "const a = 1;\nconst b = '#fff';",
      filename: FILE,
      errors: [
        { messageId: 'rawColour', data: { kind: 'hex colour', text: '#fff' }, line: 2, column: 11 },
      ],
    },
  ],
});

describe('local/no-raw-colour: scope', () => {
  it('applies to TypeScript and TSX of the web package', () => {
    const scope = scopeOf('no-raw-colour');

    expect(scope.files).toEqual(['apps/web/src/**/*.{ts,tsx}']);
    expect(scope.ignores).toEqual([]);
  });
});
