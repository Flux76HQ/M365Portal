import { LIMITS } from '@m365portal/shared/limits';
import { UploadIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { ApiError, type ApiClient } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { Warnings } from './LogoSlot';
import { useImportBranding } from './queries';
import type { Branding, ImportResult, ImportedImageSummary } from './types';

// Import with a dry run and a confirmation (T-A-214; FR-A-132, FR-A-083, H-42).
//
// The file is read as text and sent as it is, with `?dryRun=true` first: the server checks everything
// (version, images, limits) and stores nothing. The outcome is shown in words: the name, the accent
// and what each of the three images is, with the warnings that processing raised. Only the button
// "Apply import" sends the real import, with `If-Match` of the revision the page was loaded at. The
// browser never interprets the file: no parsing, no preview of the images, nothing inserted as markup.

export interface ImportPanelProps {
  /** The revision the page was loaded at: a real import is checked against it. */
  readonly revision: number;
  /** Offline, conflict or a running save: the buttons that send something are off. */
  readonly disabled: boolean;
  readonly describedBy: string | undefined;
  /** The page has edits that an applied import would replace. */
  readonly dirty: boolean;
  readonly api?: ApiClient;
  /** An applied import: the new branding. */
  readonly onApplied: (branding: Branding) => void;
  /** Any failure, for the page to show (toast, conflict banner, offline state). */
  readonly onError: (error: unknown) => void;
  /** A new attempt starts: the page forgets the previous failure. */
  readonly onStart: () => void;
}

function tooLarge(): ApiError {
  return new ApiError({
    code: 'payload_too_large',
    status: 413,
    requestId: null,
    errors: [],
    expectedOrigin: null,
    retryAfterSeconds: null,
  });
}

const IMAGES = [
  ['logoLight', 'appearance.import.image.logoLight'],
  ['logoDark', 'appearance.import.image.logoDark'],
  ['compact', 'appearance.import.image.compact'],
] as const;

function ImageLine({
  label,
  image,
}: {
  readonly label: string;
  readonly image: ImportedImageSummary | null;
}) {
  const { t, locale } = useTranslator();
  const size = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    (image?.bytes ?? 0) / 1024,
  );
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-x-2">
        <span className="font-medium text-fg">{label}</span>
        <span className="text-fg-secondary">
          {image === null
            ? t('appearance.import.imageNone')
            : t('appearance.import.imageSummary', {
                width: image.width,
                height: image.height,
                size,
              })}
        </span>
      </div>
      {image !== null && image.warnings.length > 0 ? (
        <Warnings warnings={image.warnings} label={label} />
      ) : null}
    </li>
  );
}

export function ImportPanel({
  revision,
  disabled,
  describedBy,
  dirty,
  api,
  onApplied,
  onError,
  onStart,
}: ImportPanelProps) {
  const { t } = useTranslator();
  const titleId = useId();
  const inputReference = useRef<HTMLInputElement>(null);
  const importer = useImportBranding(api);
  const [checked, setChecked] = useState<{ text: string; result: ImportResult } | null>(null);
  const busy = importer.isPending;

  async function choose(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    onStart();
    setChecked(null);
    if (file.size > LIMITS.body.importRequestBytes) {
      onError(tooLarge());
      return;
    }
    try {
      const text = await file.text();
      const result = await importer.mutateAsync({ text, dryRun: true });
      setChecked({ text, result });
    } catch (error) {
      onError(error);
    }
  }

  async function apply(): Promise<void> {
    if (checked === null) return;
    onStart();
    try {
      const result = await importer.mutateAsync({
        text: checked.text,
        dryRun: false,
        revision,
      });
      setChecked(null);
      if (result.branding !== null) onApplied(result.branding);
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-start gap-1">
        <Button
          variant="secondary"
          disabled={disabled || busy}
          aria-describedby={describedBy}
          onClick={() => {
            inputReference.current?.click();
          }}
        >
          <UploadIcon aria-hidden="true" />
          {t('appearance.import.button')}
        </Button>
        <p className="text-body-sm text-fg-muted">{t('appearance.import.hint')}</p>
        {/* The file button above is the visible control; this input is its engine. */}
        <input
          ref={inputReference}
          type="file"
          accept="application/json,.json"
          tabIndex={-1}
          aria-hidden="true"
          aria-label={t('appearance.import.fileLabel')}
          className="sr-only"
          data-slot="import-file"
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            // The same file can be chosen again after a fix.
            void choose(file).finally(() => {
              input.value = '';
            });
          }}
        />
      </div>

      {busy && checked === null ? (
        <p role="status" className="text-body-sm text-fg-secondary">
          {t('appearance.import.checking')}
        </p>
      ) : null}

      {checked === null ? null : (
        <section
          aria-labelledby={titleId}
          data-slot="import-result"
          className="flex flex-col gap-3 rounded-lg border border-line-subtle bg-surface-raised p-4"
        >
          <div className="flex flex-col gap-1">
            <h3 id={titleId} className="text-subtitle font-semibold text-fg">
              {t('appearance.import.resultTitle')}
            </h3>
            <p className="text-body-sm text-fg-muted">{t('appearance.import.resultDescription')}</p>
          </div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-[max-content_minmax(0,1fr)]">
            <dt className="font-medium text-fg">{t('appearance.import.name')}</dt>
            <dd className="min-w-0 break-words text-fg-secondary">
              <bdi>{checked.result.orgName}</bdi>
            </dd>
            <dt className="font-medium text-fg">{t('appearance.import.accent')}</dt>
            <dd className="text-fg-secondary">{checked.result.accent}</dd>
          </dl>
          <div className="flex flex-col gap-1">
            <h4 className="text-body font-medium text-fg">{t('appearance.import.imagesTitle')}</h4>
            <ul className="flex flex-col gap-2 text-body-sm">
              {IMAGES.map(([member, key]) => (
                <ImageLine key={member} label={t(key)} image={checked.result.images[member]} />
              ))}
            </ul>
          </div>
          {dirty ? (
            <p className="text-body-sm text-fg-secondary">{t('appearance.import.replaceNote')}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={disabled || busy}
              aria-busy={busy ? true : undefined}
              aria-describedby={describedBy}
              onClick={() => {
                void apply();
              }}
            >
              {busy ? t('appearance.import.applying') : t('appearance.import.apply')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setChecked(null);
              }}
            >
              {t('appearance.import.cancel')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
