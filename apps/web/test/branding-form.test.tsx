// The Appearance form and page (T-A-214; FR-A-132, FR-A-133, FR-A-134; US-2; seam X2). The page runs on the
// real route tree with a fake branding server behind it (branding/form-helpers.tsx): save with the
// `If-Match` of the loaded revision, conflicts that overwrite nothing, reset with a confirmation that names
// the object, Undo through the new revision, export link, import with a dry run, the unsaved-changes guard,
// offline, the gate and the words of every problem code.
import { createTranslator } from '@m365portal/shared/i18n';
import { PROBLEM_CODES, problemMessageKey } from '@m365portal/shared/problem';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { loadBrandingTools } from '../src/features/branding/tools';
import { translateProblemCode } from '../src/lib/problem';
import type { RecordedCall } from './branding/helpers';
import { HASH_A, assetRef, brandingWith, renderAppearance } from './branding/form-helpers';

const en = createTranslator('en');
const nl = createTranslator('nl');

async function open(options: Parameters<typeof renderAppearance>[0] = {}) {
  await loadBrandingTools();
  const view = await renderAppearance(options);
  const labels = options.language === 'nl' ? nl : en;
  const name = await screen.findByRole<HTMLInputElement>('textbox', {
    name: new RegExp(labels.t('appearance.name.label')),
  });
  return { ...view, name, labels };
}

const putCalls = (calls: RecordedCall[]) => calls.filter((call) => call.method === 'PUT');
const loginBody = (call: RecordedCall | undefined) =>
  JSON.parse(call?.body as string) as Record<string, unknown> & { logos: Record<string, unknown> };

async function typeName(view: Awaited<ReturnType<typeof open>>, text: string): Promise<void> {
  await view.user.clear(view.name);
  if (text !== '') await view.user.type(view.name, text);
}

describe('the page', () => {
  it('is the Appearance page at the same URL, with one h1 and the form', async () => {
    const view = await open();
    expect(
      screen.getByRole('heading', { level: 1, name: en.t('nav.appearance') }),
    ).toBeInTheDocument();
    expect(view.router.state.location.pathname).toBe('/settings/appearance');
    expect(view.name).toHaveValue('Acme');
    expect(screen.getByRole('textbox', { name: en.t('accent.hexLabel') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en.t('logo.title') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en.t('preview.title') })).toBeInTheDocument();
    expect(screen.getByText(en.t('appearance.clean'))).toBeInTheDocument();
  });

  it('is in Dutch when the page is Dutch', async () => {
    await open({ language: 'nl' });
    expect(screen.getByText(nl.t('appearance.description'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: nl.t('appearance.save') })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: nl.t('appearance.reset.button') }),
    ).toBeInTheDocument();
  });

  it('is gated by settings:branding: another actor sees No access and no form', async () => {
    await renderAppearance({ me: sampleMe({ permissions: ['settings:connection'] }) });
    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('pages.noAccess.title') }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: en.t('accent.hexLabel') }),
    ).not.toBeInTheDocument();
  });
});

describe('inline validation', () => {
  it('says why a blank name cannot be saved, with the words of the server code, and sends nothing', async () => {
    const view = await open();
    await typeName(view, '   ');
    expect(await screen.findByText(en.t('problem.org_name_invalid'))).toBeInTheDocument();
    expect(view.name).toHaveAttribute('aria-invalid', 'true');
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    expect(putCalls(view.writes())).toHaveLength(0);
  });

  it('says why a colour that is not a colour cannot be saved', async () => {
    const view = await open();
    const accent = screen.getByRole('textbox', { name: en.t('accent.hexLabel') });
    await view.user.clear(accent);
    await view.user.type(accent, 'blue');
    expect(await screen.findByText(en.t('problem.accent_invalid'))).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    expect(putCalls(view.writes())).toHaveLength(0);
  });

  it('puts the server code in the field when the browser accepted what the server refuses', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    view.server.failNext = [422, 'org_name_invalid'];
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    expect(await screen.findAllByText(en.t('problem.org_name_invalid'))).not.toHaveLength(0);
    expect(view.name).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('save', () => {
  it('sends PUT with the If-Match of the loaded revision, then offers Undo', async () => {
    const view = await open({ branding: brandingWith({ revision: 7 }) });
    await typeName(view, 'Contoso');
    const accent = screen.getByRole('textbox', { name: en.t('accent.hexLabel') });
    await view.user.clear(accent);
    await view.user.type(accent, '#abc');
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));

    await screen.findByText(en.t('appearance.saved'));
    const [call] = putCalls(view.writes());
    expect(call?.headers.get('If-Match')).toBe('"7"');
    expect(JSON.parse(call?.body as string)).toEqual({
      orgName: 'Contoso',
      accent: '#aabbcc',
      logos: { light: null, dark: null, compact: null },
    });
    expect(screen.getByRole('button', { name: en.t('appearance.undo') })).toBeInTheDocument();
    // The page now stands on the new revision: the form is clean and the next save carries "8".
    expect(screen.getByText(en.t('appearance.clean'))).toBeInTheDocument();
    expect(view.name).toHaveValue('Contoso');
    await typeName(view, 'Fabrikam');
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    await waitFor(() => {
      expect(putCalls(view.writes())).toHaveLength(2);
    });
    expect(putCalls(view.writes())[1]?.headers.get('If-Match')).toBe('"8"');
  });

  it('keeps Save off while there is nothing to save', async () => {
    await open();
    expect(screen.getByRole('button', { name: en.t('appearance.save') })).toBeDisabled();
  });

  it('Undo re-applies the previous values through the revision the save produced', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    await view.user.click(await screen.findByRole('button', { name: en.t('appearance.undo') }));

    await screen.findByText(en.t('appearance.undone'));
    const puts = putCalls(view.writes());
    expect(puts).toHaveLength(2);
    expect(puts[1]?.headers.get('If-Match')).toBe('"2"');
    expect(JSON.parse(puts[1]?.body as string)).toMatchObject({ orgName: 'Acme' });
    expect(view.name).toHaveValue('Acme');
    expect(view.server.current.orgName).toBe('Acme');
  });

  it('Undo fails safely with a conflict when somebody saved in between', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    const undoButton = await screen.findByRole('button', { name: en.t('appearance.undo') });
    view.server.bumpFromElsewhere({ orgName: 'Someone Else' });
    await view.user.click(undoButton);

    expect(await screen.findByText(en.t('appearance.conflict.title'))).toBeInTheDocument();
    // The other person's change stands; the page overwrote nothing.
    expect(view.server.current.orgName).toBe('Someone Else');
  });
});

describe('conflicts', () => {
  it('a 412 shows the conflict message with a reload action and overwrites nothing', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    view.server.bumpFromElsewhere({ orgName: 'Someone Else' });
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));

    expect(await screen.findByText(en.t('appearance.conflict.title'))).toBeInTheDocument();
    expect(view.server.current.orgName).toBe('Someone Else');
    // The person's edit is still there, and Save is off until the latest is loaded.
    expect(view.name).toHaveValue('Contoso');
    expect(screen.getByRole('button', { name: en.t('appearance.save') })).toBeDisabled();

    await view.user.click(screen.getByRole('button', { name: en.t('appearance.conflict.reload') }));
    await waitFor(() => {
      expect(view.name).toHaveValue('Someone Else');
    });
    await waitFor(() => {
      expect(screen.queryByText(en.t('appearance.conflict.title'))).not.toBeInTheDocument();
    });
  });

  it('a newer revision in the cache with edits on the page is a conflict before anyone saves', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    const newer = view.server.bumpFromElsewhere({ orgName: 'Someone Else' });
    act(() => {
      view.queryClient.setQueryData(['branding'], newer);
    });
    expect(await screen.findByText(en.t('appearance.conflict.title'))).toBeInTheDocument();
    expect(view.name).toHaveValue('Contoso');
    expect(putCalls(view.writes())).toHaveLength(0);
  });

  it('a newer revision in the cache without edits is simply taken over', async () => {
    const view = await open();
    const newer = view.server.bumpFromElsewhere({ orgName: 'Someone Else' });
    act(() => {
      view.queryClient.setQueryData(['branding'], newer);
    });
    await waitFor(() => {
      expect(view.name).toHaveValue('Someone Else');
    });
    expect(screen.queryByText(en.t('appearance.conflict.title'))).not.toBeInTheDocument();
  });
});

describe('reset', () => {
  it('asks a confirmation that names "Appearance of <organisation>", and does nothing on Cancel', async () => {
    const view = await open();
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.reset.button') }));
    const dialog = await screen.findByRole('alertdialog');
    // The name sits in a <bdi> inside the sentence (E-07), so the sentence is read from the element.
    expect(dialog.querySelector('[data-slot="confirm-object"]')).toHaveTextContent(
      /^Appearance of Acme$/,
    );
    await view.user.click(
      within(dialog).getByRole('button', { name: en.t('appearance.reset.cancel') }),
    );
    expect(view.writes()).toHaveLength(0);
    expect(view.server.current.revision).toBe(1);
  });

  it('resets with the If-Match of the loaded revision and offers Undo, which restores through the new revision', async () => {
    const view = await open({ branding: brandingWith({ revision: 3, accent: '#ff0000' }) });
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.reset.button') }));
    const dialog = await screen.findByRole('alertdialog');
    await view.user.click(
      within(dialog).getByRole('button', { name: en.t('appearance.reset.confirm') }),
    );

    await screen.findByText(en.t('appearance.reset.done'));
    const del = view.writes().find((call) => call.method === 'DELETE');
    expect(del?.headers.get('If-Match')).toBe('"3"');
    await waitFor(() => {
      expect(view.name).toHaveValue('M365Portal');
    });

    await view.user.click(screen.getByRole('button', { name: en.t('appearance.undo') }));
    await screen.findByText(en.t('appearance.undone'));
    const put = putCalls(view.writes())[0];
    expect(put?.headers.get('If-Match')).toBe('"4"');
    expect(JSON.parse(put?.body as string)).toMatchObject({ orgName: 'Acme', accent: '#ff0000' });
    expect(view.name).toHaveValue('Acme');
  });

  it('a conflict on reset closes the dialog, shows the conflict message and resets nothing', async () => {
    const view = await open();
    view.server.bumpFromElsewhere({ orgName: 'Someone Else' });
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.reset.button') }));
    const dialog = await screen.findByRole('alertdialog');
    await view.user.click(
      within(dialog).getByRole('button', { name: en.t('appearance.reset.confirm') }),
    );
    expect(await screen.findByText(en.t('appearance.conflict.title'))).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(view.server.current.orgName).toBe('Someone Else');
  });
});

describe('export', () => {
  it('is a plain link to the export route', async () => {
    await open();
    const link = screen.getByRole('link', { name: en.t('appearance.export.button') });
    expect(link).toHaveAttribute('href', '/api/v1/branding/export');
  });
});

describe('import', () => {
  const summary = (hash: string | null) =>
    hash === null
      ? null
      : { hash, width: 240, height: 80, bytes: 4096, warnings: [{ code: 'animation_flattened' }] };
  const result = (dryRun: boolean) => ({
    dryRun,
    applied: !dryRun,
    orgName: 'Imported Org',
    accent: '#336699',
    images: { logoLight: summary(HASH_A), logoDark: null, compact: null },
    branding: dryRun ? null : brandingWith({ orgName: 'Imported Org', accent: '#336699' }),
  });
  const file = () =>
    new File([JSON.stringify({ schemaVersion: 1 })], 'appearance.json', {
      type: 'application/json',
    });

  it('reads the file, sends ?dryRun=true, shows the outcome and applies only after confirmation', async () => {
    const view = await open();
    view.server.importAnswer = result;
    const input = document.querySelector<HTMLInputElement>('input[data-slot="import-file"]')!;
    act(() => {
      fireEvent.change(input, { target: { files: [file()] } });
    });

    const outcome = await screen.findByRole('region', {
      name: en.t('appearance.import.resultTitle'),
    });
    expect(within(outcome).getByText('Imported Org')).toBeInTheDocument();
    expect(within(outcome).getByText('#336699')).toBeInTheDocument();
    expect(within(outcome).getByText(/240 × 80 px, 4 kB/)).toBeInTheDocument();
    expect(within(outcome).getAllByText(en.t('appearance.import.imageNone'))).toHaveLength(2);
    expect(within(outcome).getByText(en.t('logo.warning.animationFlattened'))).toBeInTheDocument();
    const dry = view.writes()[0];
    expect(dry?.url).toContain('dryRun=true');
    expect(dry?.headers.get('If-Match')).toBeNull();
    // Nothing was applied yet.
    expect(view.writes()).toHaveLength(1);
    expect(view.server.current.orgName).toBe('Acme');

    await view.user.click(
      within(outcome).getByRole('button', { name: en.t('appearance.import.apply') }),
    );
    await screen.findByText(en.t('appearance.import.appliedUndo'));
    const real = view.writes()[1];
    expect(real?.url).toContain('dryRun=false');
    expect(real?.headers.get('If-Match')).toBe('"1"');
    await waitFor(() => {
      expect(view.name).toHaveValue('Imported Org');
    });
    expect(
      screen.queryByRole('region', { name: en.t('appearance.import.resultTitle') }),
    ).toBeNull();
  });

  it('Cancel drops the checked file without sending anything more', async () => {
    const view = await open();
    view.server.importAnswer = result;
    const input = document.querySelector<HTMLInputElement>('input[data-slot="import-file"]')!;
    act(() => {
      fireEvent.change(input, { target: { files: [file()] } });
    });
    await view.user.click(
      await screen.findByRole('button', { name: en.t('appearance.import.cancel') }),
    );
    expect(
      screen.queryByRole('region', { name: en.t('appearance.import.resultTitle') }),
    ).toBeNull();
    expect(view.writes()).toHaveLength(1);
  });

  it('shows a refused file in words and keeps the saved appearance', async () => {
    const view = await open();
    const input = document.querySelector<HTMLInputElement>('input[data-slot="import-file"]')!;
    act(() => {
      fireEvent.change(input, { target: { files: [file()] } });
    });
    expect(await screen.findByText(en.t('problem.import_invalid'))).toBeInTheDocument();
    expect(view.server.current.revision).toBe(1);
  });
});

describe('the unsaved-changes guard', () => {
  it('stops a move inside the app, names the object, and lets the person stay or leave', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    act(() => {
      void view.router.navigate({ to: '/' });
    });
    const dialog = await screen.findByRole('alertdialog');
    // The name sits in a <bdi> inside the sentence (E-07), so the sentence is read from the element.
    expect(dialog.querySelector('[data-slot="confirm-object"]')).toHaveTextContent(
      /^Appearance of Acme$/,
    );
    expect(view.router.state.location.pathname).toBe('/settings/appearance');

    await view.user.click(
      within(dialog).getByRole('button', { name: en.t('appearance.leave.cancel') }),
    );
    expect(view.router.state.location.pathname).toBe('/settings/appearance');
    expect(view.name).toHaveValue('Contoso');

    act(() => {
      void view.router.navigate({ to: '/' });
    });
    await view.user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: en.t('appearance.leave.confirm'),
      }),
    );
    await waitFor(() => {
      expect(view.router.state.location.pathname).toBe('/');
    });
  });

  it('lets a clean page go without asking', async () => {
    const view = await open();
    await act(async () => {
      await view.router.navigate({ to: '/' });
    });
    expect(view.router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks the browser before the tab closes, only while there are edits', async () => {
    const view = await open();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await typeName(view, 'Contoso');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('offline', () => {
  it('a request that got no answer switches Save, Import and Reset off and explains why', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    view.server.failNext = 'network';
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));

    expect(await screen.findByText(en.t('pwa.offline.title'))).toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: en.t('appearance.save') });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute('aria-describedby', 'offline-state');
    expect(screen.getByRole('button', { name: en.t('appearance.import.button') })).toBeDisabled();
    expect(screen.getByRole('button', { name: en.t('appearance.reset.button') })).toBeDisabled();
    // Nothing was queued; the edit is still on the page.
    expect(view.name).toHaveValue('Contoso');

    await view.user.click(screen.getByRole('button', { name: en.t('pwa.offline.retry') }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: en.t('appearance.save') })).toBeEnabled();
    });
  });
});

describe('problem codes', () => {
  const pageCodes = Object.keys(PROBLEM_CODES).filter(
    (code) =>
      [
        'branding_conflict',
        'accent_invalid',
        'org_name_invalid',
        'asset_unknown',
        'staging_quota_exceeded',
        'payload_too_large',
        'rate_limited',
        'origin_not_allowed',
        'permission_denied',
        'precondition_required',
      ].includes(code) || /^(image_|svg_|import_|storage_)/.test(code),
  );

  it('covers every group the page can receive', () => {
    for (const prefix of ['image_', 'svg_', 'import_', 'storage_']) {
      expect(pageCodes.some((code) => code.startsWith(prefix))).toBe(true);
    }
    expect(pageCodes).toContain('branding_conflict');
  });

  it.each(pageCodes)('%s has its own message in both languages', (code) => {
    for (const translator of [en, nl]) {
      expect(problemMessageKey(code)).toBe(`problem.${code}`);
      const message = translateProblemCode(translator, code, {
        requestId: 'req-1',
        expectedOrigin: 'https://panel.example.com',
        retryAfterSeconds: 3,
      });
      expect(message).not.toBe('');
      expect(message).not.toBe(translateProblemCode(translator, 'unknown_future_code'));
    }
    expect(translateProblemCode(en, code)).not.toBe(translateProblemCode(nl, code));
  });

  it('a save that fails with a code shows that code in words, not the server text', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    view.server.failNext = [403, 'permission_denied'];
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    expect(await screen.findByText(en.t('problem.permission_denied'))).toBeInTheDocument();
    expect(screen.queryByText('English detail')).not.toBeInTheDocument();
    expect(screen.queryByText('English title')).not.toBeInTheDocument();
  });

  it('shows the origin the panel expects for origin_not_allowed', async () => {
    const view = await open();
    await typeName(view, 'Contoso');
    view.server.failNext = [
      403,
      'origin_not_allowed',
      { expectedOrigin: 'https://panel.example.com' },
    ];
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    expect(await screen.findByText(/https:\/\/panel\.example\.com/)).toBeInTheDocument();
  });
});

describe('logos in the form', () => {
  it('sends the hash of a logo that is already staged and null for the others', async () => {
    const view = await open({ branding: brandingWith({ logos: { light: assetRef(HASH_A) } }) });
    await typeName(view, 'Contoso');
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    await screen.findByText(en.t('appearance.saved'));
    expect(loginBody(putCalls(view.writes())[0]).logos).toEqual({
      light: HASH_A,
      dark: null,
      compact: null,
    });
  });

  it('sends null for a compact logo the server derived, so it is derived again', async () => {
    const view = await open({
      branding: brandingWith({
        logos: { light: assetRef(HASH_A), compact: assetRef('c'.repeat(64)) },
        compactDerived: true,
      }),
    });
    await typeName(view, 'Contoso');
    await view.user.click(screen.getByRole('button', { name: en.t('appearance.save') }));
    await screen.findByText(en.t('appearance.saved'));
    expect(loginBody(putCalls(view.writes())[0]).logos.compact).toBeNull();
  });
});
