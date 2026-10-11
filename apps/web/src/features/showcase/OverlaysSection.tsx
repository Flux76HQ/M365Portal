import { CopyIcon, InfoIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Breadcrumbs } from '../../components/ui/breadcrumbs';
import { Button } from '../../components/ui/button';
import { CommandBar, type CommandBarGroup } from '../../components/ui/command-bar';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { DetailsPanel } from '../../components/ui/details-panel';
import { Dialog } from '../../components/ui/dialog';
import { IconButton } from '../../components/ui/icon-button';
import { Menu } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useToast, type ToastTone } from '../../components/ui/toast';
import { useTranslator } from '../../lib/locale';
import { ComponentSection, Specimen } from './Specimen';

// Everything that opens, pops up or announces: menu, tooltip, dialog, confirm dialog, toast, details
// panel, command palette; and the navigation helpers breadcrumbs and command bar. Each overlay is one
// "open" specimen: the trigger. Opening it is how the state is seen.

const TONES: readonly ToastTone[] = ['info', 'success', 'warning', 'error'];

function MenuDemo() {
  const { t } = useTranslator();
  const { toast } = useToast();
  return (
    <ComponentSection id="menu">
      <Specimen component="menu" state="open">
        <Menu
          trigger={<Button>{t('showcase.menu.open')}</Button>}
          align="start"
          entries={[
            { kind: 'label', label: t('showcase.menu.label') },
            { kind: 'item', id: 'edit', label: t('showcase.menu.edit'), icon: <PencilIcon /> },
            { kind: 'item', id: 'copy', label: t('showcase.menu.copy'), icon: <CopyIcon /> },
            { kind: 'separator' },
            {
              kind: 'item',
              id: 'delete',
              label: t('showcase.menu.delete'),
              icon: <Trash2Icon />,
              destructive: true,
            },
          ]}
          onSelect={() => {
            toast({ title: t('showcase.menu.chosen'), tone: 'info' });
          }}
        />
      </Specimen>
    </ComponentSection>
  );
}

function TooltipDemo() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="tooltip">
      <Specimen component="tooltip" state="open">
        <Tooltip content={t('showcase.tooltip.text')}>
          <IconButton label={t('showcase.tooltip.label')}>
            <InfoIcon className="size-4" />
          </IconButton>
        </Tooltip>
      </Specimen>
    </ComponentSection>
  );
}

function DialogDemo() {
  const { t } = useTranslator();
  const [open, setOpen] = useState(false);
  return (
    <ComponentSection id="dialog">
      <Specimen component="dialog" state="open">
        <Dialog
          open={open}
          onOpenChange={setOpen}
          trigger={<Button>{t('showcase.dialog.open')}</Button>}
          title={t('showcase.dialog.title')}
          description={t('showcase.dialog.description')}
          closeLabel={t('showcase.dialog.close')}
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t('showcase.dialog.ok')}
            </Button>
          }
        >
          <p className="text-body text-fg">{t('showcase.dialog.body')}</p>
        </Dialog>
      </Specimen>
    </ComponentSection>
  );
}

function ConfirmDemo() {
  const { t } = useTranslator();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <ComponentSection id="confirm-dialog">
      <Specimen component="confirm-dialog" state="open">
        <Button
          variant="destructive"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('showcase.confirm.open')}
        </Button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          objectName={t('showcase.confirm.object')}
          title={t('showcase.confirm.title')}
          description={t('showcase.confirm.description')}
          confirmLabel={t('showcase.confirm.confirm')}
          cancelLabel={t('showcase.confirm.cancel')}
          onConfirm={() => {
            setOpen(false);
            toast({ title: t('showcase.confirm.done'), tone: 'success' });
          }}
        />
      </Specimen>
    </ComponentSection>
  );
}

function ToastDemo() {
  const { t } = useTranslator();
  const { toast } = useToast();
  return (
    <ComponentSection id="toast">
      <Specimen component="toast" state="open">
        <div className="flex flex-wrap gap-2">
          {TONES.map((tone) => (
            <Button
              key={tone}
              onClick={() => {
                toast({
                  title: t(`showcase.toast.${tone}Title`),
                  description: t('showcase.toast.description'),
                  tone,
                });
              }}
            >
              {t(`showcase.toast.${tone}`)}
            </Button>
          ))}
        </div>
      </Specimen>
    </ComponentSection>
  );
}

function DetailsDemo() {
  const { t } = useTranslator();
  const [open, setOpen] = useState(false);
  return (
    <ComponentSection id="details-panel">
      <Specimen component="details-panel" state="open">
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('showcase.details.open')}
        </Button>
        <DetailsPanel
          open={open}
          onOpenChange={setOpen}
          title={t('showcase.details.title')}
          description={t('showcase.details.description')}
          closeLabel={t('showcase.details.close')}
        >
          <p className="text-body text-fg">{t('showcase.details.body')}</p>
        </DetailsPanel>
      </Specimen>
    </ComponentSection>
  );
}

function PaletteDemo() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="command-palette">
      <Specimen component="command-palette" state="open">
        <Button
          onClick={() => {
            // The palette belongs to the shell; its own shortcut opens it from anywhere.
            document.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
            );
          }}
        >
          {t('showcase.palette.open')}
        </Button>
      </Specimen>
    </ComponentSection>
  );
}

function BreadcrumbsDemo() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="breadcrumbs">
      <Specimen component="breadcrumbs" state="default">
        <Breadcrumbs
          label={t('showcase.breadcrumbs.label')}
          items={[
            { id: 'home', label: t('showcase.breadcrumbs.home'), href: '/design' },
            { id: 'directory', label: t('showcase.breadcrumbs.directory'), href: '/design' },
            { id: 'current', label: t('showcase.breadcrumbs.long') },
          ]}
          renderLink={({ className, title, children }) => (
            <Link to="/design" className={className} title={title}>
              {children}
            </Link>
          )}
        />
      </Specimen>
    </ComponentSection>
  );
}

function CommandBarDemo() {
  const { t } = useTranslator();
  const { toast } = useToast();
  const run = (): void => {
    toast({ title: t('showcase.commandBar.done'), tone: 'info' });
  };
  const groups = (disabled: boolean): CommandBarGroup[] => [
    {
      id: 'edit',
      label: t('showcase.commandBar.edit'),
      items: [
        {
          id: 'new',
          label: t('showcase.commandBar.new'),
          icon: <PlusIcon />,
          onSelect: run,
          disabled,
        },
        {
          id: 'edit',
          label: t('showcase.commandBar.change'),
          icon: <PencilIcon />,
          onSelect: run,
          disabled,
        },
        { id: 'copy', label: t('showcase.commandBar.copy'), icon: <CopyIcon />, onSelect: run },
      ],
    },
    {
      id: 'danger',
      label: t('showcase.commandBar.remove'),
      items: [
        {
          id: 'delete',
          label: t('showcase.commandBar.delete'),
          icon: <Trash2Icon />,
          onSelect: run,
          destructive: true,
          disabled,
        },
      ],
    },
  ];
  return (
    <ComponentSection id="command-bar">
      {(['default', 'disabled'] as const).map((state) => (
        <Specimen key={state} component="command-bar" state={state}>
          <CommandBar
            label={t('showcase.commandBar.label')}
            moreLabel={t('showcase.commandBar.more')}
            groups={groups(state === 'disabled')}
            maxVisible={3}
          />
        </Specimen>
      ))}
    </ComponentSection>
  );
}

export function OverlaysSection() {
  return (
    <>
      <MenuDemo />
      <TooltipDemo />
      <DialogDemo />
      <ConfirmDemo />
      <ToastDemo />
      <DetailsDemo />
      <PaletteDemo />
    </>
  );
}

export function NavigationSection() {
  return (
    <>
      <BreadcrumbsDemo />
      <CommandBarDemo />
    </>
  );
}
