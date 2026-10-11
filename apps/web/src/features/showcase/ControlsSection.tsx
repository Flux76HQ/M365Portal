import { SettingsIcon } from 'lucide-react';
import { useState } from 'react';
import { Button, type ButtonProps } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { FormField } from '../../components/ui/form-field';
import { IconButton } from '../../components/ui/icon-button';
import { Input } from '../../components/ui/input';
import { RadioGroup, RadioOption } from '../../components/ui/radio-group';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { Select } from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Textarea } from '../../components/ui/textarea';
import { useTranslator } from '../../lib/locale';
import { ComponentSection, FORCED_FOCUS, Specimen } from './Specimen';

// Buttons, text fields, choices and tabs. Each specimen is one state of one component; the forced
// classes draw hover and focus without a pointer (the same utilities the components use for the real
// thing), which is also what the visual regression run needs.

const VARIANTS = ['primary', 'secondary', 'ghost', 'destructive', 'link'] as const;
const FORCED_HOVER: Record<(typeof VARIANTS)[number], string> = {
  primary: 'bg-accent-hover',
  secondary: 'bg-accent-subtle',
  ghost: 'bg-accent-subtle',
  destructive: 'bg-surface-page',
  link: 'text-accent-hover',
};

function ButtonRow({
  force,
  ...props
}: Omit<ButtonProps, 'variant' | 'className'> & { readonly force?: 'hover' | 'focus' }) {
  const { t } = useTranslator();
  // The link variant has no forced hover: its hover colour, `accent-hover` used as text, is below 4.5:1
  // on the dark page surface (axe, color-contrast), which is S3's token to settle (chunk note, open point).
  const variants = force === 'hover' ? VARIANTS.filter((variant) => variant !== 'link') : VARIANTS;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {variants.map((variant) => (
        <Button
          key={variant}
          variant={variant}
          className={
            force === 'hover' ? FORCED_HOVER[variant] : force === 'focus' ? FORCED_FOCUS : undefined
          }
          {...props}
        >
          {t(`showcase.button.${variant}`)}
        </Button>
      ))}
    </div>
  );
}

function Buttons() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="button">
      <Specimen component="button" state="default">
        <ButtonRow />
      </Specimen>
      <Specimen component="button" state="hover">
        <ButtonRow force="hover" />
      </Specimen>
      <Specimen component="button" state="focus">
        <ButtonRow force="focus" />
      </Specimen>
      <Specimen component="button" state="disabled">
        <ButtonRow disabled />
      </Specimen>
      <Specimen component="button" state="loading">
        <Button variant="primary" aria-busy="true" disabled>
          {t('showcase.button.busy')}
        </Button>
      </Specimen>
    </ComponentSection>
  );
}

function IconButtons() {
  const { t } = useTranslator();
  const icon = <SettingsIcon className="size-4" />;
  const label = t('showcase.iconButton.label');
  return (
    <ComponentSection id="icon-button">
      <Specimen component="icon-button" state="default">
        <IconButton label={label}>{icon}</IconButton>
      </Specimen>
      <Specimen component="icon-button" state="hover">
        <IconButton label={label} className="bg-accent-subtle">
          {icon}
        </IconButton>
      </Specimen>
      <Specimen component="icon-button" state="focus">
        <IconButton label={label} className={FORCED_FOCUS}>
          {icon}
        </IconButton>
      </Specimen>
      <Specimen component="icon-button" state="disabled">
        <IconButton label={label} disabled>
          {icon}
        </IconButton>
      </Specimen>
    </ComponentSection>
  );
}

type FieldState = 'default' | 'focus' | 'disabled' | 'invalid';
const FIELD_STATES: readonly FieldState[] = ['default', 'focus', 'disabled', 'invalid'];

function Inputs() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="input">
      {FIELD_STATES.map((state) => (
        <Specimen key={state} component="input" state={state}>
          <FormField
            label={t('showcase.field.label')}
            hint={state === 'invalid' ? undefined : t('showcase.field.hint')}
            error={state === 'invalid' ? t('showcase.field.error') : undefined}
            className="w-full"
          >
            {(control) => (
              <Input
                {...control}
                defaultValue={t('showcase.field.value')}
                disabled={state === 'disabled'}
                className={state === 'focus' ? FORCED_FOCUS : undefined}
              />
            )}
          </FormField>
        </Specimen>
      ))}
    </ComponentSection>
  );
}

function Textareas() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="textarea">
      {FIELD_STATES.map((state) => (
        <Specimen key={state} component="textarea" state={state}>
          <FormField
            label={t('showcase.field.label')}
            hint={state === 'invalid' ? undefined : t('showcase.field.hint')}
            error={state === 'invalid' ? t('showcase.field.error') : undefined}
            className="w-full"
          >
            {(control) => (
              <Textarea
                {...control}
                defaultValue={t('showcase.field.value')}
                disabled={state === 'disabled'}
                className={state === 'focus' ? FORCED_FOCUS : undefined}
              />
            )}
          </FormField>
        </Specimen>
      ))}
    </ComponentSection>
  );
}

function Selects() {
  const { t } = useTranslator();
  const options = [
    { value: 'one', label: t('showcase.sample.first') },
    { value: 'two', label: t('showcase.sample.second') },
    { value: 'three', label: t('showcase.sample.third') },
  ];
  return (
    <ComponentSection id="select">
      {FIELD_STATES.map((state) => (
        <Specimen key={state} component="select" state={state}>
          <FormField
            label={t('showcase.field.label')}
            hint={state === 'invalid' ? undefined : t('showcase.field.hint')}
            error={state === 'invalid' ? t('showcase.field.error') : undefined}
            className="w-full"
          >
            {(control) => (
              <Select
                {...control}
                options={options}
                placeholder={t('showcase.select.placeholder')}
                defaultValue="two"
                disabled={state === 'disabled'}
                className={state === 'focus' ? FORCED_FOCUS : undefined}
              />
            )}
          </FormField>
        </Specimen>
      ))}
    </ComponentSection>
  );
}

function Checkboxes() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="checkbox">
      {FIELD_STATES.map((state) => (
        <Specimen key={state} component="checkbox" state={state}>
          <FormField
            layout="inline"
            label={t('showcase.checkbox.label')}
            error={state === 'invalid' ? t('showcase.checkbox.error') : undefined}
          >
            {(control) => (
              <Checkbox
                {...control}
                defaultChecked={state === 'default' || state === 'disabled'}
                disabled={state === 'disabled'}
                className={state === 'focus' ? FORCED_FOCUS : undefined}
              />
            )}
          </FormField>
        </Specimen>
      ))}
    </ComponentSection>
  );
}

function RadioGroups() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="radio-group">
      {FIELD_STATES.map((state) => (
        <Specimen key={state} component="radio-group" state={state}>
          <FormField
            label={t('showcase.radio.label')}
            error={state === 'invalid' ? t('showcase.radio.error') : undefined}
          >
            {(control) => (
              <RadioGroup
                {...control}
                defaultValue={state === 'invalid' ? undefined : 'one'}
                disabled={state === 'disabled'}
              >
                <RadioOption
                  value="one"
                  label={t('showcase.sample.first')}
                  className={
                    state === 'focus'
                      ? '[&_button]:outline-2 [&_button]:outline-offset-2 [&_button]:outline-focus-ring'
                      : undefined
                  }
                />
                <RadioOption value="two" label={t('showcase.sample.second')} />
              </RadioGroup>
            )}
          </FormField>
        </Specimen>
      ))}
    </ComponentSection>
  );
}

function Switches() {
  const { t } = useTranslator();
  const label = t('showcase.switch.label');
  return (
    <ComponentSection id="switch">
      {(['default', 'focus', 'disabled'] as const).map((state) => (
        <Specimen key={state} component="switch" state={state}>
          <label className="flex items-center gap-3 text-body text-fg">
            <Switch
              defaultChecked={state !== 'default'}
              disabled={state === 'disabled'}
              className={state === 'focus' ? FORCED_FOCUS : undefined}
            />
            {label}
          </label>
        </Specimen>
      ))}
    </ComponentSection>
  );
}

function Segmented() {
  const { t } = useTranslator();
  const [value, setValue] = useState('list');
  const options = [
    { value: 'list', label: t('showcase.segmented.list') },
    { value: 'grid', label: t('showcase.segmented.grid') },
    { value: 'board', label: t('showcase.segmented.board') },
  ];
  const first = '[&_[role=radio]:first-child]';
  const classes = {
    default: undefined,
    hover: `${first}:text-fg`,
    focus: `${first}:outline-2 ${first}:outline-offset-2 ${first}:outline-focus-ring`,
    disabled: undefined,
  } as const;
  return (
    <ComponentSection id="segmented-control">
      {(['default', 'hover', 'focus', 'disabled'] as const).map((state) => (
        <Specimen key={state} component="segmented-control" state={state}>
          <SegmentedControl
            label={t('showcase.segmented.label')}
            options={options}
            value={value}
            onValueChange={setValue}
            disabled={state === 'disabled'}
            className={classes[state]}
          />
        </Specimen>
      ))}
    </ComponentSection>
  );
}

function TabsDemo() {
  const { t } = useTranslator();
  const forced = {
    default: undefined,
    hover: 'text-fg',
    focus: FORCED_FOCUS,
    disabled: undefined,
  } as const;
  return (
    <ComponentSection id="tabs">
      {(['default', 'hover', 'focus', 'disabled'] as const).map((state) => (
        <Specimen key={state} component="tabs" state={state}>
          <Tabs defaultValue="overview" className="w-full">
            <TabsList label={t('showcase.tabs.label')}>
              <TabsTrigger value="overview">{t('showcase.tabs.overview')}</TabsTrigger>
              <TabsTrigger value="details" className={forced[state]}>
                {t('showcase.tabs.details')}
              </TabsTrigger>
              <TabsTrigger value="history" disabled={state === 'disabled'}>
                {t('showcase.tabs.history')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="text-body text-fg-secondary">
              {t('showcase.tabs.panel')}
            </TabsContent>
            <TabsContent value="details" className="text-body text-fg-secondary">
              {t('showcase.tabs.panel')}
            </TabsContent>
          </Tabs>
        </Specimen>
      ))}
    </ComponentSection>
  );
}

export function ControlsSection() {
  return (
    <>
      <Buttons />
      <IconButtons />
      <Inputs />
      <Textareas />
      <Selects />
      <Checkboxes />
      <RadioGroups />
      <Switches />
      <Segmented />
      <TabsDemo />
    </>
  );
}
