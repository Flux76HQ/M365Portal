import { useState, type SyntheticEvent } from 'react';
import { Button } from '../../components/ui/button';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { useToast } from '../../components/ui/toast';
import { useTranslator } from '../../lib/locale';
import { ComponentSection, Specimen } from './Specimen';

// Inline validation (FR-A-124 FormField): a field is checked when the form is submitted, the message names
// the problem and sits under the field, it is announced, and it goes when the value is fixed. The first
// field with a problem takes the focus. Nothing is sent anywhere: this is a demonstration.

interface Values {
  readonly name: string;
  readonly email: string;
}
type Problems = Partial<Record<keyof Values, 'nameRequired' | 'emailInvalid'>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validate(values: Values): Problems {
  const problems: Problems = {};
  if (values.name.trim() === '') problems.name = 'nameRequired';
  if (!EMAIL.test(values.email.trim())) problems.email = 'emailInvalid';
  return problems;
}

function FormDemo() {
  const { t } = useTranslator();
  const { toast } = useToast();
  const [values, setValues] = useState<Values>({ name: '', email: '' });
  const [problems, setProblems] = useState<Problems>({});

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validate(values);
    setProblems(found);
    const first = (['name', 'email'] as const).find((field) => found[field] !== undefined);
    if (first !== undefined) {
      event.currentTarget.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    toast({ title: t('showcase.form.saved'), tone: 'success' });
  }

  return (
    <form noValidate onSubmit={submit} className="flex w-full flex-col gap-4">
      <FormField
        label={t('showcase.form.name')}
        required
        requiredLabel={t('showcase.form.required')}
        error={problems.name === undefined ? undefined : t(`showcase.form.${problems.name}`)}
      >
        {(control) => (
          <Input
            {...control}
            name="name"
            autoComplete="off"
            value={values.name}
            onChange={(event) => {
              setValues({ ...values, name: event.target.value });
            }}
          />
        )}
      </FormField>
      <FormField
        label={t('showcase.form.email')}
        required
        requiredLabel={t('showcase.form.required')}
        hint={t('showcase.form.emailHint')}
        error={problems.email === undefined ? undefined : t(`showcase.form.${problems.email}`)}
      >
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="off"
            value={values.email}
            onChange={(event) => {
              setValues({ ...values, email: event.target.value });
            }}
          />
        )}
      </FormField>
      <Button type="submit" variant="primary" className="self-start">
        {t('showcase.form.submit')}
      </Button>
    </form>
  );
}

export function FormSection() {
  const { t } = useTranslator();
  return (
    <ComponentSection id="form-field" stacked>
      <Specimen component="form-field" state="default" caption={t('showcase.form.caption')}>
        <FormDemo />
      </Specimen>
      <Specimen component="form-field" state="invalid">
        <FormField
          label={t('showcase.field.label')}
          error={t('showcase.field.error')}
          required
          requiredLabel={t('showcase.form.required')}
          className="w-full"
        >
          {(control) => <Input {...control} defaultValue={t('showcase.field.value')} />}
        </FormField>
      </Specimen>
      <Specimen component="form-field" state="disabled">
        <FormField
          label={t('showcase.field.label')}
          hint={t('showcase.field.hint')}
          className="w-full"
        >
          {(control) => <Input {...control} defaultValue={t('showcase.field.value')} disabled />}
        </FormField>
      </Specimen>
    </ComponentSection>
  );
}
