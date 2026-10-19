// The export dialog of a distribution list (step D2, FR-D-401, FR-D-402, FR-D-404, FR-D-405, US-D5): the format
// (the Laposta preset, all columns, or the person's own choice), the two filters, a preview of the first rows
// as the server makes them (the same function as the download), the privacy notice, and the download. The
// download is the server's CSV kept in memory and handed to the browser as a file; nothing is stored. It is a
// chunk of its own, loaded when the button is first pressed (`ListExport`).
//
// A download needs a fresh sign-in: when the server asks for it (`step_up_required`) the session dialog
// opens and the person presses the button again; the choices stay.
import { EXPORT_COLUMNS, type ExportColumn } from '@m365portal/shared/csv/presets';
import type { MessageKey } from '@m365portal/shared/i18n';
import type { ExportOptions } from '@m365portal/shared/schemas/export';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Dialog } from '../../components/ui/dialog';
import { RadioGroup, RadioOption } from '../../components/ui/radio-group';
import { Skeleton } from '../../components/ui/skeleton';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe, useRouterContext } from '../../lib/router-context';
import { downloadExport, exportPreviewOptions } from './queries';

type Preset = ExportOptions['preset'];
type Separator = NonNullable<ExportOptions['separator']>;

export interface ExportDialogProps {
  readonly id: string;
  readonly name: string;
  readonly open: boolean;
  readonly onClose: () => void;
}

const COLUMN_LABELS: Readonly<Record<ExportColumn, MessageKey>> = {
  email: 'distributionLists.export.column.email',
  firstName: 'distributionLists.export.column.firstName',
  lastName: 'distributionLists.export.column.lastName',
  displayName: 'distributionLists.export.column.displayName',
  type: 'distributionLists.export.column.type',
};

/** Hands a file in memory to the browser as a download. */
function saveFile(file: Blob, fileName: string): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked after the click has been handled.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function CheckOption({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => {
          onChange(value === true);
        }}
      />
      <label htmlFor={id} className="text-body text-fg">
        {label}
      </label>
    </div>
  );
}

export default function ExportDialog({ id, name, open, onClose }: ExportDialogProps) {
  const translator = useTranslator();
  const { t } = translator;
  const me = useMe();
  const { api } = useRouterContext();
  const [preset, setPreset] = useState<Preset>('laposta');
  const [columns, setColumns] = useState<ReadonlySet<ExportColumn>>(new Set(EXPORT_COLUMNS));
  const [separator, setSeparator] = useState<Separator>(';');
  const [bom, setBom] = useState(true);
  const [dedupe, setDedupe] = useState(true);
  const [skipWithoutEmail, setSkipWithoutEmail] = useState(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const noColumns = preset === 'custom' && columns.size === 0;
  const options: ExportOptions =
    preset === 'custom'
      ? {
          preset,
          columns: EXPORT_COLUMNS.filter((column) => columns.has(column)),
          separator,
          bom,
          dedupe,
          skipWithoutEmail,
        }
      : { preset, dedupe, skipWithoutEmail };

  const preview = useQuery({
    ...exportPreviewOptions(api, id, options),
    enabled: open && !noColumns,
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
  });

  async function download() {
    setPending(true);
    setFailure(null);
    setDone(false);
    try {
      const { file, fileName } = await downloadExport(api, id, options);
      saveFile(file, fileName);
      setDone(true);
    } catch (error) {
      setFailure(error);
    } finally {
      setPending(false);
    }
  }

  function toggleColumn(column: ExportColumn, checked: boolean) {
    const next = new Set(columns);
    if (checked) next.add(column);
    else next.delete(column);
    setColumns(next);
  }

  const data = preview.data;
  const shownRows = data?.rows ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('distributionLists.export.title', { name })}
      description={t('distributionLists.export.description')}
      closeLabel={t('common.close')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('distributionLists.export.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={noColumns || pending}
            aria-busy={pending ? true : undefined}
            onClick={() => {
              void download();
            }}
          >
            {pending
              ? t('distributionLists.export.downloading')
              : t('distributionLists.export.download')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-body-sm text-fg-secondary">{t('distributionLists.export.privacy')}</p>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-body font-medium text-fg">
            {t('distributionLists.export.preset.label')}
          </legend>
          <RadioGroup
            value={preset}
            onValueChange={(value) => {
              setPreset(value as Preset);
            }}
            aria-label={t('distributionLists.export.preset.label')}
          >
            <RadioOption
              value="laposta"
              label={t('distributionLists.export.preset.laposta')}
              hint={t('distributionLists.export.preset.laposta.hint')}
            />
            <RadioOption
              value="generic"
              label={t('distributionLists.export.preset.generic')}
              hint={t('distributionLists.export.preset.generic.hint')}
            />
            <RadioOption
              value="custom"
              label={t('distributionLists.export.preset.custom')}
              hint={t('distributionLists.export.preset.custom.hint')}
            />
          </RadioGroup>
        </fieldset>

        {preset === 'custom' ? (
          <div className="flex flex-col gap-3 ps-8">
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-body font-medium text-fg">
                {t('distributionLists.export.columns.label')}
              </legend>
              {EXPORT_COLUMNS.map((column) => (
                <CheckOption
                  key={column}
                  label={t(COLUMN_LABELS[column])}
                  checked={columns.has(column)}
                  onChange={(checked) => {
                    toggleColumn(column, checked);
                  }}
                />
              ))}
              {noColumns ? (
                <p role="alert" className="text-body-sm text-danger">
                  {t('distributionLists.export.columns.none')}
                </p>
              ) : null}
            </fieldset>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-body font-medium text-fg">
                {t('distributionLists.export.separator.label')}
              </legend>
              <RadioGroup
                value={separator}
                onValueChange={(value) => {
                  setSeparator(value as Separator);
                }}
                aria-label={t('distributionLists.export.separator.label')}
              >
                <RadioOption value=";" label={t('distributionLists.export.separator.semicolon')} />
                <RadioOption value="," label={t('distributionLists.export.separator.comma')} />
              </RadioGroup>
            </fieldset>
            <CheckOption
              label={t('distributionLists.export.bom')}
              checked={bom}
              onChange={setBom}
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <CheckOption
            label={t('distributionLists.export.dedupe')}
            checked={dedupe}
            onChange={setDedupe}
          />
          <CheckOption
            label={t('distributionLists.export.skipWithoutEmail')}
            checked={skipWithoutEmail}
            onChange={setSkipWithoutEmail}
          />
        </div>

        <section aria-labelledby={`${id}-preview`} className="flex flex-col gap-2">
          <h3 id={`${id}-preview`} className="text-body font-medium text-fg">
            {t('distributionLists.export.preview.heading')}
          </h3>
          {noColumns ? null : data === undefined && preview.isError ? (
            <p role="alert" className="text-body-sm text-danger">
              {t('distributionLists.export.preview.error')}{' '}
              {messageForError(translator, preview.error, { publicOrigin: me.publicOrigin })}
            </p>
          ) : data === undefined ? (
            <div aria-busy="true" aria-label={t('distributionLists.export.preview.loading')}>
              <Skeleton height={96} />
            </div>
          ) : (
            <>
              <pre
                // A scrollable region is reachable by keyboard (WCAG 2.1.1).
                role="region"
                tabIndex={0}
                aria-label={t('distributionLists.export.preview.label')}
                className="overflow-auto rounded-md border border-line-subtle bg-surface-page p-2 text-body-sm"
              >
                {data.csv}
              </pre>
              <p className="text-body-sm text-fg-secondary">
                {t(
                  data.more
                    ? 'distributionLists.export.preview.more'
                    : 'distributionLists.export.preview.all',
                  { count: shownRows },
                )}
              </p>
              {data.skipped > 0 ? (
                <p className="text-body-sm text-fg-secondary">
                  {t('distributionLists.export.preview.skipped', { count: data.skipped })}
                </p>
              ) : null}
            </>
          )}
        </section>

        <p className="text-body-sm text-fg-secondary">{t('distributionLists.export.stepUp')}</p>
        {failure === null ? null : (
          <div role="alert" className="flex flex-col gap-1 text-body-sm">
            <p className="font-medium text-danger">{t('distributionLists.export.error')}</p>
            <p className="text-fg-secondary">
              {messageForError(translator, failure, { publicOrigin: me.publicOrigin })}
            </p>
          </div>
        )}
        {done ? (
          <p role="status" className="text-body-sm text-fg-secondary">
            {t('distributionLists.export.done')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
