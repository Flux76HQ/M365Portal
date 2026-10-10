// local/no-literal-ui-strings (FR-A-115): no user-visible literal string in JSX text or in the
// user-facing attributes outside the catalogues. The RuleTester suite below proves the rule's
// behaviour on source text; tools/lint-canary proves it is enabled in the real eslint.config.js,
// in the right folder, at the right severity.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

const FILE = 'apps/web/src/components/Example.tsx';
const rule = ruleOf('no-literal-ui-strings');

/** The attributes the rule inspects on every element (T-A-006, and G0 defect D17 for the rest). */
const CHECKED_ATTRIBUTES = [
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'title',
  'placeholder',
  'alt',
  'aria-valuetext',
  'aria-braillelabel',
  'aria-brailleroledescription',
  'children',
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

    // Constants that are not text, calls, and objects that carry no user-facing key (G0 defect D10).
    validCase(
      "const heading = t('users.title'); const a = <h1>{heading}</h1>;",
      'a const holding a call',
    ),
    validCase("const sep = ' / '; const a = <p>{x}{sep}{y}</p>;", 'a const without a letter'),
    validCase(
      "const klass = 'flex'; const a = <div className={klass} />;",
      'not a listed attribute',
    ),
    validCase(
      "let heading = 'Users'; const a = <h1>{heading}</h1>;",
      'a let may be reassigned: not followed',
    ),
    validCase('const a = <h1>{title}</h1>;', 'an identifier that is not a const of this file'),
    validCase('const { title } = props; const a = <h1>{title}</h1>;', 'a destructured binding'),
    validCase("const props = { 'aria-label': t('close') }; const a = <button {...props} />;"),
    validCase(
      "const props = { title: '', alt: '—', placeholder: undefined };",
      'no letter, no value',
    ),
    validCase(
      "const props = { label: 'Save', name: 'save', id: 'main' };",
      'keys that are not listed',
    ),
    validCase("const { title = 'Default' } = props;", 'a default in a destructuring pattern'),
    validCase("const a = <input {...{ placeholder: t('search') }} />;"),
    validCase('const a = <button aria-valuetext={t("half")} aria-braillelabel={t("x")} />;'),

    // Elements whose label or value is shown (G0 defect D17), written correctly or not as text.
    validCase('const a = <option value="a" label="" />;', 'an empty label'),
    validCase("const a = <optgroup label={t('group')} />;"),
    validCase('const a = <input type="submit" value={t(\'send\')} />;'),
    validCase('const a = <input type="text" value="typed" />;', 'a text field value is data'),
    validCase('const a = <input type={kind} value="x" />;', 'a type that is not known'),
    validCase(
      'const a = <option value="Draft">{t("draft")}</option>;',
      'the value of an option is data',
    ),
    validCase("const a = <Button children={t('save')} />;"),
    validCase("const a = <Wrapper>{t('save')}</Wrapper>;"),

    // Strings outside JSX are not UI text for this rule.
    validCase("const KEY = 'save changes';"),
    validCase("console.info('server started');"),
    validCase("export function fail(): never { throw new Error('bad input'); }"),
  ],

  invalid: [
    // JSX text.
    text('const a = <p>Hello</p>;', 'Hello'),
    {
      name: 'multi-line text: the report points at the words, not at the indentation',
      code: 'const a = (\n  <p>\n    Save changes\n  </p>\n);',
      filename: FILE,
      errors: [
        {
          messageId: 'jsxText',
          data: { text: 'Save changes' },
          line: 3,
          column: 5,
          endLine: 3,
          endColumn: 17,
        },
      ],
    },
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
    // Attributes that arrive through an object (G0 defect D10).
    attribute(
      "const a = <input {...{ placeholder: 'Search users' }} />;",
      'placeholder',
      'Search users',
      'a spread object literal',
    ),
    attribute(
      "const props = { 'aria-label': 'Close dialog' }; const a = <button {...props} />;",
      'aria-label',
      'Close dialog',
      'an object that is spread later',
    ),
    attribute(
      "const input = createElement('input', { placeholder: 'Search' });",
      'placeholder',
      'Search',
      'props of createElement',
    ),
    attribute("const meta = { title: 'Dashboard' };", 'title', 'Dashboard', 'a page title in data'),
    attribute('const meta = { alt: `Logo` };', 'alt', 'Logo', 'a template'),
    attribute("const meta = { children: 'Save' };", 'children', 'Save', 'children in props'),
    {
      name: 'both branches of a conditional in an object',
      code: "const meta = { title: open ? 'Close' : 'Open' };",
      filename: FILE,
      errors: [
        { messageId: 'attribute', data: { name: 'title', text: 'Close' } },
        { messageId: 'attribute', data: { name: 'title', text: 'Open' } },
      ],
    },

    // Text kept in a const and shown later (G0 defect D10): one hop, like the SQL rule.
    text(
      "const heading = 'Users overview'; const a = <h1>{heading}</h1>;",
      'Users overview',
      'a const rendered as a child',
    ),
    attribute(
      "const label = 'Close'; const a = <button aria-label={label} />;",
      'aria-label',
      'Close',
      'a const used as an attribute',
    ),
    text(
      'const heading = `Users ${n}`; const a = <h1>{heading}</h1>;',
      'Users',
      'a template const',
    ),
    {
      name: 'a const with two branches is reported once per branch, at the place it is shown',
      code: "const word = open ? 'Open' : 'Closed'; const a = <p>{word}</p>;",
      filename: FILE,
      errors: [
        { messageId: 'jsxText', data: { text: 'Open' }, line: 1, column: 54 },
        { messageId: 'jsxText', data: { text: 'Closed' }, line: 1, column: 54 },
      ],
    },
    text(
      "const a = <p>{name ?? DEFAULT}</p>; const DEFAULT = 'Anonymous';",
      'Anonymous',
      'a const declared after its use',
    ),

    // Elements whose label or value is text (G0 defect D17).
    attribute(
      'const a = <option value="a" label="First choice" />;',
      'label',
      'First choice',
      'option',
    ),
    attribute('const a = <optgroup label="Group" />;', 'label', 'Group', 'optgroup'),
    attribute('const a = <track kind="captions" label="English" />;', 'label', 'English', 'track'),
    attribute('const a = <input type="submit" value="Send" />;', 'value', 'Send', 'submit button'),
    attribute('const a = <input type="button" value="Open" />;', 'value', 'Open', 'button input'),
    attribute(
      "const a = <input type='reset' value={'Clear'} />;",
      'value',
      'Clear',
      'reset button',
    ),
    attribute(
      'const a = <Button children="Save" />;',
      'children',
      'Save',
      'children as an attribute',
    ),
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
  it('applies to every component file of the web package, a test-named one included', () => {
    const scope = scopeOf('no-literal-ui-strings');

    expect(scope.files).toEqual(['apps/web/src/**/*.{tsx,jsx}']);
    // Tests live in apps/web/test, outside this scope. A *.test.tsx beside the sources is nobody's
    // test (repo-conventions.test.ts check 9), so it was never a reason to switch the rule off.
    expect(scope.ignores).toEqual([]);
  });
});
