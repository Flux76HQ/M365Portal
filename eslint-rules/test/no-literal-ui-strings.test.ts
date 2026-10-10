// local/no-literal-ui-strings (FR-A-115): no user-visible literal string in JSX text or in the
// user-facing attributes outside the catalogues. The RuleTester suite below proves the rule's
// behaviour on source text; tools/lint-canary proves it is enabled in the real eslint.config.js,
// in the right folder, at the right severity.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

const FILE = 'apps/web/src/components/Example.tsx';
const rule = ruleOf('no-literal-ui-strings');

/** The attributes the rule inspects (T-A-006). */
const CHECKED_ATTRIBUTES = [
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'title',
  'placeholder',
  'alt',
] as const;

function validCase(code: string, name?: string): RuleTester.ValidTestCase {
  return { name: name ?? code, code, filename: FILE };
}

function text(code: string, shown: string, name?: string): RuleTester.InvalidTestCase {
  return {
    name: name ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'jsxText', data: { text: shown } }],
  };
}

function attribute(
  code: string,
  attributeName: string,
  shown: string,
  name?: string,
): RuleTester.InvalidTestCase {
  return {
    name: name ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'attribute', data: { name: attributeName, text: shown } }],
  };
}

createRuleTester().run('local/no-literal-ui-strings', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    // Catalogue calls and values that come from elsewhere.
    validCase("const a = <p>{t('dashboard.title')}</p>;"),
    validCase(
      "const a = <p>{t('dashboard.greeting', { name: 'Alex' })}</p>;",
      'call arguments are data',
    ),
    validCase('const a = <p>{count}</p>;'),
    validCase('const a = <p>{user.name}</p>;'),
    validCase("const a = <p>{open ? t('a') : t('b')}</p>;"),
    validCase("const a = <p>{ready && t('a')}</p>;"),
    validCase("const a = <p>{name ?? t('anonymous')}</p>;"),
    validCase("const a = <p>{label || t('fallback')}</p>;"),
    validCase("const a = <>{t('x')}</>;", 'a fragment with a catalogue call'),

    // Text without a letter: whitespace, punctuation, digits, symbols.
    validCase('const a = <p>   </p>;', 'blank text'),
    validCase('const a = (\n  <p>\n    {x}\n  </p>\n);', 'line breaks and indentation only'),
    validCase('const a = <span>-</span>;', 'dash'),
    validCase('const a = <span>…</span>;', 'ellipsis'),
    validCase('const a = <span>1,234.56</span>;', 'number'),
    validCase('const a = <span>12:30</span>;', 'time'),
    validCase('const a = <span>© 2026</span>;', 'symbol and digits'),
    validCase('const a = <span>→</span>;', 'arrow'),
    validCase('const a = <span>&nbsp;</span>;', 'non-breaking space entity'),
    validCase('const a = <span>&times;</span>;', 'multiplication sign entity'),
    validCase('const a = <span>&#8212;</span>;', 'numeric entity'),
    validCase('const a = <span>%</span>;'),
    validCase('const a = <span>١٢٣</span>;', 'digits of another script are digits, not letters'),
    validCase("const a = <span>{' '}</span>;", 'a string container holding a space'),
    validCase("const a = <span>{'/'}</span>;", 'a string container holding punctuation'),
    validCase('const a = <span>{`${a}/${b}`}</span>;', 'a template of expressions and punctuation'),
    validCase("const a = <span>{count + '%'}</span>;", 'concatenation without a letter'),

    // Attributes that are not on the list, and values that are not user text.
    validCase('const a = <div className="flex items-center" data-testid="save" id="main" />;'),
    validCase('const a = <a href="https://example.com" target="_blank" rel="noreferrer" />;'),
    validCase('const a = <svg viewBox="0 0 24 24" aria-hidden="true" />;'),
    validCase('const a = <div role="button" lang="en" dir="ltr" />;'),
    validCase('const a = <div aria-labelledby="heading-id" aria-describedby="hint" />;'),
    validCase(
      'const a = <Button variant="primary" size="sm" label="Save" />;',
      'a prop that is not on the list is not inspected: the rule cannot know what a component does with it',
    ),
    validCase('const a = <svg><use xlink:title="Logo" /></svg>;', 'namespaced attribute'),
    validCase("const a = <input placeholder={t('search')} />;"),
    validCase("const a = <img src={url} alt={t('logo')} />;"),
    validCase('const a = <img alt="" src={url} />;', 'decorative image: empty alt'),
    validCase('const a = <button title="—" />;', 'attribute without a letter'),
    validCase('const a = <input placeholder="…" />;'),
    validCase('const a = <input placeholder />;', 'boolean attribute without a value'),
    validCase('const a = <button title={`${a}`} />;'),
    validCase("const a = <button title={cond ? t('a') : undefined} />;"),

    // Strings outside JSX are not UI text for this rule.
    validCase("const KEY = 'save changes';"),
    validCase("console.info('server started');"),
    validCase("export function fail(): never { throw new Error('bad input'); }"),
  ],

  invalid: [
    // JSX text.
    text('const a = <p>Hello</p>;', 'Hello'),
    text('const a = (\n  <p>\n    Save changes\n  </p>\n);', 'Save changes', 'multi-line text'),
    text('const a = <p>{count} items</p>;', 'items', 'text next to an expression'),
    text('const a = <p>Total: {n}</p>;', 'Total:'),
    text('const a = <>Hello</>;', 'Hello', 'text in a fragment'),
    text('const a = <p>&eacute;</p>;', 'é', 'an entity that decodes to a letter'),
    text('const a = <p>Привет</p>;', 'Привет', 'Cyrillic'),
    text('const a = <p>日本語</p>;', '日本語', 'Han'),
    text('const a = <p>naïve</p>;', 'naïve', 'accented Latin'),
    text('const a = <p>x</p>;', 'x', 'a single letter'),
    text(
      'const a = <p>This is a very long sentence that goes on and on and on</p>;',
      'This is a very long sentence that goes o…',
      'long text is shortened in the message',
    ),
    {
      name: 'two texts in one tree',
      code: 'const a = <ul><li>One</li><li>Two</li></ul>;',
      filename: FILE,
      errors: [
        { messageId: 'jsxText', data: { text: 'One' }, line: 1 },
        { messageId: 'jsxText', data: { text: 'Two' }, line: 1 },
      ],
    },

    // Literal strings inside a JSX child container.
    text("const a = <p>{'Hello'}</p>;", 'Hello', 'string literal child'),
    text('const a = <p>{`Hello`}</p>;', 'Hello', 'template literal child without expressions'),
    text(
      'const a = <p>{`Hello ${name}`}</p>;',
      'Hello',
      'template literal child with an expression',
    ),
    text("const a = <p>{'Hello ' + name}</p>;", 'Hello', 'concatenation child'),
    text(
      "const a = <p>{name + ' items'}</p>;",
      'items',
      'concatenation child, literal on the right',
    ),
    text(
      "const a = <p>{ready && 'Loading'}</p>;",
      'Loading',
      'logical and: the right side is shown',
    ),
    text("const a = <p>{name ?? 'none'}</p>;", 'none', 'nullish fallback'),
    text("const a = <p>{label || 'Untitled'}</p>;", 'Untitled', 'or fallback'),
    text("const a = <p>{'Hello' as string}</p>;", 'Hello', 'type assertion is looked through'),
    text("const a = <p>{('Hello')}</p>;", 'Hello', 'parentheses are looked through'),
    {
      name: 'both branches of a conditional',
      code: "const a = <p>{open ? 'Open' : 'Closed'}</p>;",
      filename: FILE,
      errors: [
        { messageId: 'jsxText', data: { text: 'Open' } },
        { messageId: 'jsxText', data: { text: 'Closed' } },
      ],
    },

    // Every listed attribute, as a string literal.
    ...CHECKED_ATTRIBUTES.map((name) =>
      attribute(`const a = <div ${name}="Some text" />;`, name, 'Some text', `${name} literal`),
    ),
    attribute(
      'const a = <Button title="Save" />;',
      'title',
      'Save',
      'on a component, not only on DOM tags',
    ),
    attribute(
      "const a = <input placeholder={'Search'} />;",
      'placeholder',
      'Search',
      'string in braces',
    ),
    attribute(
      'const a = <input placeholder={`Search`} />;',
      'placeholder',
      'Search',
      'template in braces',
    ),
    attribute(
      'const a = <input placeholder={`Search ${scope}`} />;',
      'placeholder',
      'Search',
      'template with an expression',
    ),
    attribute(
      "const a = <button aria-label={label || 'Close'} />;",
      'aria-label',
      'Close',
      'fallback',
    ),
    attribute("const a = <button title={'Delete ' + name} />;", 'title', 'Delete', 'concatenation'),
    attribute('const a = <img alt="Ωmega" />;', 'alt', 'Ωmega', 'Greek letter'),
    {
      name: 'both branches of a conditional attribute',
      code: "const a = <button aria-label={open ? 'Close' : 'Open'} />;",
      filename: FILE,
      errors: [
        { messageId: 'attribute', data: { name: 'aria-label', text: 'Close' } },
        { messageId: 'attribute', data: { name: 'aria-label', text: 'Open' } },
      ],
    },
    {
      name: 'several offences on one element are all reported',
      code: 'const a = <img alt="Logo" title="Brand" />;',
      filename: FILE,
      errors: [
        { messageId: 'attribute', data: { name: 'alt', text: 'Logo' } },
        { messageId: 'attribute', data: { name: 'title', text: 'Brand' } },
      ],
    },
    {
      name: 'attribute and text together',
      code: "const a = <Button aria-label='Close'>Save</Button>;",
      filename: FILE,
      errors: [
        { messageId: 'attribute', data: { name: 'aria-label', text: 'Close' } },
        { messageId: 'jsxText', data: { text: 'Save' } },
      ],
    },
  ],
});

describe('local/no-literal-ui-strings: scope', () => {
  it('applies to .tsx files of the web package and leaves tests alone', () => {
    const scope = scopeOf('no-literal-ui-strings');

    expect(scope.files).toEqual(['apps/web/src/**/*.tsx']);
    expect(scope.ignores).toEqual(
      expect.arrayContaining(['apps/web/src/**/*.test.tsx', 'apps/web/src/**/*.spec.tsx']),
    );
  });
});
