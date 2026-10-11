import { AlertCircleIcon, ImageIcon, InfoIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { LIMITS } from '@m365portal/shared/limits';
import { Button } from '../../components/ui/button';
import { ApiError, NetworkError, type ApiClient } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useStageAsset } from './queries';
import {
  LOGO_VARIANTS,
  SLOT_OF_VARIANT,
  type AssetRef,
  type LogoVariant,
  type UploadWarning,
} from './types';

// The logo slot (T-A-212; FR-A-132, FR-A-152, WCAG 2.5.7; E-02, E-05; US-2.2).
//
// One slot is one logo: the light theme, the dark theme or the compact one. The file goes to the server
// as it is (one multipart part); the server decodes, sanitises and re-encodes it, and what comes back
// is an `AssetRef` that this slot shows as `<img src="/branding/<hash>.png">`. The browser never reads
// the file: no object URL, no FileReader, no markup of any kind from an upload.
//
// Drag and drop is an extra, never the only way (WCAG 2.5.7): the file button is always there.
// Progress is indeterminate: the API client is the only code that talks to the network and `fetch`
// reports no upload progress, so the bar says "working" and Cancel aborts the request.

const ACCEPT = 'image/png,image/jpeg,image/svg+xml';

export interface LogoSlotProps {
  readonly variant: LogoVariant;
  /** The logo in this slot (the server's answer), or null. */
  readonly asset: AssetRef | null;
  /** The compact logo was made by the server from the main one: it is shown, but there is nothing to remove. */
  readonly derived?: boolean;
  readonly disabled?: boolean;
  /** A new processed asset, or null after Remove. Called only after the server accepted the file. */
  readonly onChange: (asset: AssetRef | null) => void;
  /** The API client (a test passes one over a fake network). */
  readonly api?: ApiClient;
}

/** The only url an image of ours may have. Anything else is not shown, whatever the data says. */
function isAssetUrl(asset: AssetRef): boolean {
  return /^[0-9a-f]{64}$/.test(asset.hash) && asset.url === `/branding/${asset.hash}.png`;
}

function toAssetRef(staged: AssetRef): AssetRef {
  return {
    hash: staged.hash,
    url: staged.url,
    width: staged.width,
    height: staged.height,
    luminance: staged.luminance,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
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

/** A retry that unlocks when the server's `Retry-After` has run out. */
function RetryButton({
  seconds,
  onRetry,
}: {
  readonly seconds: number;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslator();
  const [remaining, setRemaining] = useState(seconds);
  const counting = remaining > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      setRemaining((value) => Math.max(0, value - 1));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [counting]);
  return (
    <Button variant="secondary" size="sm" disabled={remaining > 0} onClick={onRetry}>
      {remaining > 0 ? t('logo.retryWait', { seconds: remaining }) : t('logo.retry')}
    </Button>
  );
}

export function Warnings({
  warnings,
  label,
}: {
  readonly warnings: readonly UploadWarning[];
  readonly label: string;
}) {
  const { t, locale } = useTranslator();
  if (warnings.length === 0) return null;
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  return (
    <div role="status" aria-label={label} className="rounded-md bg-surface-page p-3">
      <ul className="flex flex-col gap-2">
        {warnings.map((warning) => (
          <li key={warning.code} className="flex items-start gap-2 text-body-sm text-fg-secondary">
            <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
            <span>
              {warning.code === 'svg_content_removed'
                ? t('logo.warning.svgContentRemoved', {
                    categories: list.format(
                      warning.categories.map((category) => t(`logo.category.${category}`)),
                    ),
                  })
                : t('logo.warning.animationFlattened')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LogoSlot({
  variant,
  asset,
  derived = false,
  disabled = false,
  onChange,
  api,
}: LogoSlotProps) {
  const { t } = useTranslator();
  const headingId = useId();
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const stage = useStageAsset(api);

  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<{ readonly error: unknown; readonly file: File } | null>(
    null,
  );
  const [notes, setNotes] = useState<{
    readonly hash: string;
    readonly warnings: readonly UploadWarning[];
  } | null>(null);

  const pending = stage.isPending;
  const locked = disabled || pending;
  const slotName = t(`logo.slot.${variant}.name`);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const upload = (file: File): void => {
    setFailure(null);
    if (file.size > LIMITS.body.logoFileBytes) {
      setFailure({ error: tooLarge(), file });
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    stage.mutate(
      { slot: SLOT_OF_VARIANT[variant], file, signal: abort.signal },
      {
        onSuccess: (response) => {
          setNotes({ hash: response.asset.hash, warnings: response.warnings });
          onChange(toAssetRef(response.asset));
        },
        onError: (error) => {
          if (!isAbort(error)) setFailure({ error, file });
        },
      },
    );
  };

  const cancel = (): void => {
    controller.current?.abort();
    stage.reset();
  };

  // --- drag and drop (the extra way) -------------------------------------------------------------
  const carriesFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes('Files');

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (locked || !carriesFiles(event)) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (locked || !carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      return;
    setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (locked) return;
    const file = event.dataTransfer.files[0];
    if (file !== undefined) upload(file);
  };

  const shown = asset !== null && isAssetUrl(asset) ? asset : null;
  const retryable =
    failure !== null &&
    (failure.error instanceof NetworkError ||
      (failure.error instanceof ApiError && failure.error.retryAfterSeconds !== null));
  const retrySeconds =
    failure !== null && failure.error instanceof ApiError
      ? (failure.error.retryAfterSeconds ?? 0)
      : 0;
  const warnings =
    notes !== null && asset !== null && notes.hash === asset.hash ? notes.warnings : [];

  return (
    <div
      role="group"
      aria-label={t(`logo.slot.${variant}.label`)}
      data-slot="logo-slot"
      data-variant={variant}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line-subtle bg-surface-raised p-4"
    >
      <div className="flex flex-col gap-1">
        <h4 id={headingId} className="text-body font-medium text-fg">
          {t(`logo.slot.${variant}.label`)}
        </h4>
        <p className="text-body-sm text-fg-muted">{t(`logo.slot.${variant}.hint`)}</p>
      </div>

      <div
        data-slot="logo-dropzone"
        data-dragging={dragging}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'flex min-h-32 flex-col items-center justify-center gap-3 rounded-md border border-dashed p-3 text-center',
          'transition-colors duration-fast ease-standard',
          dragging ? 'border-accent bg-accent-subtle' : 'border-line-control bg-surface-page',
        )}
      >
        {dragging ? (
          <p className="text-body-sm font-medium text-fg">{t('logo.dropActive')}</p>
        ) : shown !== null ? (
          <>
            <img
              src={shown.url}
              alt={t('logo.previewAlt', { slot: slotName })}
              width={shown.width}
              height={shown.height}
              className="max-h-16 max-w-full object-contain"
            />
            <p className="text-caption text-fg-muted">
              {t('logo.size', { width: shown.width, height: shown.height })}
            </p>
            {derived ? <p className="text-body-sm text-fg-secondary">{t('logo.derived')}</p> : null}
          </>
        ) : (
          <>
            <ImageIcon aria-hidden="true" className="size-6 text-fg-muted" />
            <p className="text-body-sm text-fg-secondary">{t('logo.empty')}</p>
          </>
        )}
        {!dragging ? <p className="text-caption text-fg-muted">{t('logo.dropHint')}</p> : null}

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={locked}
            aria-label={t(shown === null ? 'logo.chooseLabel' : 'logo.replaceLabel', {
              slot: slotName,
            })}
            onClick={() => {
              input.current?.click();
            }}
          >
            {t(shown === null ? 'logo.choose' : 'logo.replace')}
          </Button>
          {shown !== null && !derived ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              aria-label={t('logo.removeLabel', { slot: slotName })}
              onClick={() => {
                setNotes(null);
                setFailure(null);
                onChange(null);
              }}
            >
              {t('logo.remove')}
            </Button>
          ) : null}
          {pending ? (
            <Button variant="ghost" size="sm" onClick={cancel}>
              {t('logo.cancel')}
            </Button>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          data-slot="logo-file-input"
          className="sr-only"
          disabled={locked}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) upload(file);
          }}
        />
      </div>

      {pending ? (
        <div className="flex flex-col gap-1">
          <div
            role="progressbar"
            aria-label={t('logo.uploading', { slot: slotName })}
            className="h-1.5 overflow-hidden rounded-full bg-line-subtle"
          >
            <div className="h-full w-1/3 rounded-full bg-accent motion-safe:animate-pulse" />
          </div>
          <p className="text-caption text-fg-muted">{t('logo.uploading', { slot: slotName })}</p>
        </div>
      ) : null}

      {failure !== null ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="flex items-start gap-1.5 text-body-sm text-danger">
            <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{messageForError({ t }, failure.error)}</span>
          </p>
          {retryable ? (
            <RetryButton
              key={failure.file.name + String(retrySeconds)}
              seconds={retrySeconds}
              onRetry={() => {
                upload(failure.file);
              }}
            />
          ) : null}
        </div>
      ) : null}

      <Warnings warnings={warnings} label={t('logo.warningsTitle', { slot: slotName })} />
    </div>
  );
}

export interface LogoSlotsProps {
  readonly value: Readonly<Record<LogoVariant, AssetRef | null>>;
  /** The compact logo in `value` was made by the server. */
  readonly compactDerived: boolean;
  readonly disabled?: boolean;
  readonly onChange: (variant: LogoVariant, asset: AssetRef | null) => void;
  readonly api?: ApiClient;
}

/** The three slots in the order the page shows them. */
export function LogoSlots({
  value,
  compactDerived,
  disabled = false,
  onChange,
  api,
}: LogoSlotsProps) {
  const { t } = useTranslator();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="text-subtitle font-semibold text-fg">
          {t('logo.title')}
        </h3>
        <p className="text-body-sm text-fg-muted">{t('logo.accepted')}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {LOGO_VARIANTS.map((variant) => (
          <LogoSlot
            key={variant}
            variant={variant}
            asset={value[variant]}
            derived={variant === 'compact' && compactDerived}
            disabled={disabled}
            {...(api ? { api } : {})}
            onChange={(next) => {
              onChange(variant, next);
            }}
          />
        ))}
      </div>
    </section>
  );
}
