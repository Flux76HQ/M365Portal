// The "Export as CSV" button of a distribution list (step D2). Only the button is in the page; the dialog, with
// its form and preview, is a chunk of its own that loads when the button is first pressed. The server decides
// who may export (`distributionlists:export`, a fresh sign-in); the button is only offered to an actor who holds
// the permission somewhere.
import { lazy, Suspense, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useTranslator } from '../../lib/locale';

const ExportDialog = lazy(() => import('./ExportDialog'));

export function ListExport({ id, name }: { readonly id: string; readonly name: string }) {
  const { t } = useTranslator();
  const [wanted, setWanted] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setWanted(true);
          setOpen(true);
        }}
      >
        {t('distributionLists.export.open')}
      </Button>
      {wanted ? (
        <Suspense fallback={null}>
          <ExportDialog
            id={id}
            name={name}
            open={open}
            onClose={() => {
              setOpen(false);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
