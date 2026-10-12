// THE STEP-UP DIALOG (T-B-298; FR-B-411, FR-B-414 web half, FR-B-609; plan 12.3).
//
// A write that needs a fresh sign-in is refused with 403 `step_up_required`. The API client records that
// in the session store; this dialog opens, says what will happen and, on confirmation, navigates to
// /auth/login?purpose=stepup&returnTo=<the current path>. The write is not replayed: the person starts it
// again after coming back. Focus is trapped in the dialog and goes back to where it was.
import { createTranslator } from '@m365portal/shared/i18n';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleSignedInMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';

const en = createTranslator('en');

async function openDialog(language: 'en' | 'nl' = 'en', path = '/settings?x=1') {
  const view = await renderApp({ me: sampleSignedInMe(), path, language });
  act(() => {
    view.store.requestStepUp();
  });
  const dialog = await screen.findByRole('dialog');
  return { ...view, dialog };
}

describe('the dialog', () => {
  it('stays closed until a write needs a step-up', async () => {
    await renderApp({ me: sampleSignedInMe(), path: '/settings' });
    await screen.findByRole('main');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens when the store records step_up_required, named and described', async () => {
    const { dialog } = await openDialog();
    expect(dialog).toHaveAccessibleName(en.t('session.stepUp.title'));
    expect(dialog).toHaveAccessibleDescription(en.t('session.stepUp.message'));
    expect(within(dialog).getByRole('button', { name: en.t('session.stepUp.confirm') })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: en.t('session.stepUp.cancel') })).toBeInTheDocument();
  });

  it('is in Dutch when the page is Dutch: "Bevestig met opnieuw aanmelden"', async () => {
    const { dialog } = await openDialog('nl');
    expect(dialog).toHaveAccessibleName('Bevestig met opnieuw aanmelden');
    expect(dialog).toHaveAccessibleName(createTranslator('nl').t('session.stepUp.title'));
  });

  it('on confirmation navigates to the step-up login with the current path as returnTo, and replays nothing', async () => {
    const { dialog, user, moves } = await openDialog('en', '/settings?x=1');
    await user.click(within(dialog).getByRole('button', { name: en.t('session.stepUp.confirm') }));
    expect(moves).toEqual(['assign /auth/login?purpose=stepup&returnTo=%2Fsettings%3Fx%3D1']);
  });

  it('closes on cancel and forgets the request, without navigating', async () => {
    const { dialog, user, moves, store } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: en.t('session.stepUp.cancel') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(store.getSnapshot().stepUpRequested).toBe(false);
    expect(moves).toEqual([]);
  });

  it('closes on Escape', async () => {
    const { user } = await openDialog();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('traps the focus inside while open and gives it back to the page when it closes', async () => {
    const { dialog, user } = await openDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement), `tab ${String(press)}`).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement === document.body || document.body.contains(document.activeElement)).toBe(true);
  });

  it('does not carry an unsafe current path into returnTo', async () => {
    // /setupx is no public page, and a sign-in may never return to a path that starts with /setup.
    const { dialog, user, moves } = await openDialog('en', '/setupx');
    await user.click(within(dialog).getByRole('button', { name: en.t('session.stepUp.confirm') }));
    expect(moves).toEqual(['assign /auth/login?purpose=stepup']);
  });
});
