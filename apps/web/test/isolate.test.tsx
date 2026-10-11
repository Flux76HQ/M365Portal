// RTL ISOLATION OF USER-CONTROLLED TEXT IN A SENTENCE (E-07; defect D-3 of chunk-s9b).
//
// An organisation name is data and may be Arabic or Hebrew. Interpolated as plain text into
// "Appearance of {name}" it reorders the neighbouring neutral characters. Every sentence that embeds
// the name shows it inside an isolating element (<bdi>). The source scan keeps a new sentence from
// slipping back to plain interpolation; its negative fixture must fail on purpose.
import { expectGuardFails } from '@m365portal/shared/testing';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog } from '../src/components/ui/confirm-dialog';
import { isolatedMessage } from '../src/lib/isolate';
import { createTranslator } from '@m365portal/shared/i18n';
import { LivePreview } from '../src/features/branding/LivePreview';
import { loadBrandingTools } from '../src/features/branding/tools';
import { renderInLanguage } from './branding/helpers';

const ARABIC = 'شركة الأمل';
const HEBREW = 'חברת הדוגמה';
const here = dirname(fileURLToPath(import.meta.url));
const t = createTranslator('en').t;

describe('isolatedMessage', () => {
  for (const name of [ARABIC, HEBREW, 'Acme']) {
    it(`writes ${name} inside one <bdi> and the rest of the sentence outside it`, () => {
      const { container } = render(
        <p>{isolatedMessage(t, 'appearance.object', undefined, { name })}</p>,
      );
      const bdi = container.querySelectorAll('bdi');
      expect(bdi).toHaveLength(1);
      expect(bdi[0]?.textContent).toBe(name);
      expect(container.textContent).toBe(`Appearance of ${name}`);
    });
  }

  it('keeps markup and marker look-alikes in the value as text', () => {
    const name = '<img src=x onerror=alert(1)>0';
    const { container } = render(
      <p>{isolatedMessage(t, 'appearance.object', undefined, { name })}</p>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('bdi')?.textContent).toBe(name);
  });
});

describe('the Reset dialog sentence', () => {
  it('isolates the name when the caller passes the sentence as nodes', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        objectName={`Appearance of ${ARABIC}`}
        objectContent={isolatedMessage(t, 'appearance.object', undefined, { name: ARABIC })}
        title="Reset"
        confirmLabel="Reset"
        cancelLabel="Cancel"
        onConfirm={() => undefined}
      />,
    );
    const object = document.querySelector('[data-slot="confirm-object"]');
    expect(object?.querySelector('bdi')?.textContent).toBe(ARABIC);
    expect(object?.textContent).toBe(`Appearance of ${ARABIC}`);
  });
});

describe('the live preview sentences', () => {
  it('isolates the name in the summary and labels the pane through an isolating element', async () => {
    await loadBrandingTools();
    renderInLanguage(
      <LivePreview
        orgName={HEBREW}
        accent="#0078d4"
        logos={{ light: null, dark: null, compact: null }}
      />,
      'en',
    );
    const summaries = document.querySelectorAll('p.sr-only');
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      expect(summary.querySelector('bdi')?.textContent).toBe(HEBREW);
    }
    const group = screen.getAllByRole('group', { name: /^Preview, / })[0];
    expect(group).toBeDefined();
    expect(group?.hasAttribute('aria-label')).toBe(false);
    const labelledby = group?.getAttribute('aria-labelledby') ?? '';
    const label = document.getElementById(labelledby);
    expect(label?.querySelector('bdi')?.textContent).toBe(HEBREW);
  });
});

// The guard: a translation key that takes the organisation name is never shown from a plain `t()`
// call alone in a component; isolatedMessage fills it for display.
const SENTENCE_KEYS = ['appearance.object', 'preview.paneLabel', 'preview.summary'] as const;

function plainInterpolations(source: string): readonly string[] {
  const findings: string[] = [];
  for (const key of SENTENCE_KEYS) {
    const quoted = `['"]${key.replace('.', '\\.')}['"]`;
    const plain = new RegExp(`\\bt\\(\\s*${quoted}`);
    const isolated = new RegExp(`isolatedMessage\\(\\s*t,\\s*${quoted}`);
    // A plain call may remain as the text equivalent (the blank check of the dialog), but only next
    // to the isolating call for the same key.
    if (plain.test(source) && !isolated.test(source)) findings.push(key);
  }
  return findings;
}

describe('no plain interpolation of the organisation name into a sentence', () => {
  const files = [
    'src/features/branding/AppearanceForm.tsx',
    'src/features/branding/LivePreview.tsx',
  ];
  for (const file of files) {
    it(`${file} fills ${SENTENCE_KEYS.join(', ')} only through isolatedMessage`, () => {
      expect(plainInterpolations(readFileSync(join(here, '..', file), 'utf8'))).toEqual([]);
    });
  }

  it('fails on a source that interpolates the name as plain text (negative fixture)', () => {
    expectGuardFails((source: string) => {
      expect(plainInterpolations(source)).toEqual([]);
    }, `const x = t('appearance.object', { name: baseline.orgName });`);
  });
});
