// RESTRICTED ROWS AND STATE NOTICES (T-C-041; FR-C-307, FR-C-502, FR-C-503). A restricted row is a muted row
// with the word and the kind and nothing else; each state of spec section 5 has its own translated message.
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RestrictedRow, RestrictedValue } from '../src/features/directory/RestrictedRow';
import { StateNotice, type NoticeState } from '../src/features/directory/StateNotice';
import { LanguageProvider, createLanguageController } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';

function inLanguage(language: Locale, ui: React.ReactNode) {
  const controller = createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
  return render(<LanguageProvider controller={controller}>{ui}</LanguageProvider>);
}

describe('RestrictedRow', () => {
  it('shows the word "Restricted" and the kind, and nothing that identifies the object', () => {
    inLanguage(
      'en',
      <table>
        <tbody>
          <RestrictedRow kind="user" columns={4} />
        </tbody>
      </table>,
    );
    const row = screen.getByRole('row');
    expect(within(row).getByText('Restricted')).toBeInTheDocument();
    expect(row).toHaveTextContent('User');
    expect(within(row).queryByRole('link')).toBeNull();
    expect(row.getAttribute('data-restricted')).toBe('true');
    expect(row.innerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    // One cell across all columns, so the row reads as one sentence to a screen reader.
    expect(within(row).getAllByRole('cell')).toHaveLength(1);
    expect(within(row).getByRole('cell')).toHaveAttribute('colspan', '4');
  });

  it('names the kind of the object in both languages', () => {
    for (const language of ['en', 'nl'] as const) {
      const t = createTranslator(language).t;
      for (const [kind, key] of [
        ['user', 'groups.member.kindUser'],
        ['group', 'groups.member.kindGroup'],
        ['other', 'groups.member.kindOther'],
      ] as const) {
        const { unmount } = inLanguage(
          language,
          <table>
            <tbody>
              <RestrictedRow kind={kind} columns={2} />
            </tbody>
          </table>,
        );
        expect(screen.getByRole('row')).toHaveTextContent(t('users.restricted.row'));
        expect(screen.getByRole('row')).toHaveTextContent(t(key));
        unmount();
      }
    }
  });

  it('RestrictedValue is the inline form, for the manager of a user', () => {
    inLanguage(
      'nl',
      <p data-testid="p">
        Manager: <RestrictedValue />
      </p>,
    );
    expect(screen.getByTestId('p')).toHaveTextContent('Manager: Beperkt');
    expect(screen.getByTestId('p').querySelector('a')).toBeNull();
  });
});

describe('StateNotice', () => {
  const STATES: readonly NoticeState[] = [
    { kind: 'membersHidden' },
    { kind: 'ownersNotAvailable' },
    { kind: 'restrictedMembers', count: 3 },
    { kind: 'restrictedOwners', count: 2 },
    { kind: 'managerNone' },
    { kind: 'managerUnavailable' },
    { kind: 'cursorRestarted' },
    { kind: 'groupsMayBeMissing' },
    { kind: 'transitiveGroups' },
    { kind: 'dynamicListsNote' },
    { kind: 'dynamicMembership' },
    { kind: 'basicOnly' },
    { kind: 'readOnlyKind' },
  ];

  for (const language of ['en', 'nl'] as const) {
    it(`gives every state a message of its own (${language})`, () => {
      const seen = new Set<string>();
      for (const state of STATES) {
        const { container, unmount } = inLanguage(language, <StateNotice state={state} />);
        const text = container.textContent;
        expect(text.trim().length, state.kind).toBeGreaterThan(8);
        expect(text, `${state.kind} shows a key instead of words`).not.toMatch(
          /^[a-z]+\.[a-zA-Z.]+$/,
        );
        expect(seen.has(text), `${state.kind} repeats another message`).toBe(false);
        seen.add(text);
        unmount();
      }
      expect(seen.size).toBe(STATES.length);
    });
  }

  it('counts restricted members with the plural of the language', () => {
    const { container, unmount } = inLanguage(
      'en',
      <StateNotice state={{ kind: 'restrictedMembers', count: 1 }} />,
    );
    expect(container).toHaveTextContent('1 member you cannot see');
    unmount();
    inLanguage('nl', <StateNotice state={{ kind: 'restrictedMembers', count: 3 }} />);
    expect(document.body).toHaveTextContent('3 leden die u niet kunt zien');
  });

  it('announces only the notice that appears by itself (the restarted list)', () => {
    inLanguage('en', <StateNotice state={{ kind: 'cursorRestarted' }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/starts again from the first page/);
    inLanguage('en', <StateNotice state={{ kind: 'membersHidden' }} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('has an icon that assistive technology skips, so the text carries the meaning', () => {
    const { container } = inLanguage('en', <StateNotice state={{ kind: 'managerUnavailable' }} />);
    const icon = container.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});
