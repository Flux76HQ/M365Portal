// The form that creates or edits a contact (FR-D-302, US-D2). One plain translated message per rule, next to the
// field that breaks it; the address is normalised before it is sent; an edit sends only what changed. A refusal
// of the server is shown the same way: a code that belongs to a field (validation, conflict) at that field, any
// other as one message above the buttons. Nothing is sent while a rule is broken.
import type { ContactDetail } from '@m365portal/shared/schemas/contacts';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { useToast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { directoryKey } from '../../lib/query';
import { messageForError, translateProblemCode } from '../../lib/problem';
import { useMe, useRouterContext } from '../../lib/router-context';
import { createContact, refreshContacts, updateContact } from './queries';
import {
  isValidationCode,
  validateCreate,
  validateEdit,
  type ContactField,
  type ContactFormValues,
} from './validation';

export interface ContactFormDialogProps {
  readonly mode: 'create' | 'edit';
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The contact being edited. */
  readonly contact?: ContactDetail;
}

const EMPTY: ContactFormValues = {
  displayName: '',
  alias: '',
  externalEmailAddress: '',
  firstName: '',
  lastName: '',
};

function valuesOf(contact: ContactDetail | undefined): ContactFormValues {
  if (contact === undefined) return EMPTY;
  return {
    displayName: contact.displayName ?? '',
    alias: contact.alias ?? '',
    externalEmailAddress: contact.externalEmailAddress ?? '',
    firstName: '',
    lastName: '',
  };
}

const POINTERS: Readonly<Record<string, ContactField>> = {
  '/displayName': 'displayName',
  '/alias': 'alias',
  '/externalEmailAddress': 'externalEmailAddress',
  '/firstName': 'firstName',
  '/lastName': 'lastName',
};

export function ContactFormDialog({ mode, open, onOpenChange, contact }: ContactFormDialogProps) {
  const translator = useTranslator();
  const { t } = translator;
  const me = useMe();
  const { api, queryClient } = useRouterContext();
  const navigate = useNavigate();
  const { toast } = useToast();
  const formId = useId();
  const content = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<ContactFormValues>(valuesOf(contact));
  const [messages, setMessages] = useState<Partial<Record<ContactField, string>>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Opened again: start from the contact (or empty), without the last messages. Adjusted while rendering, as
  // the search box does, so the form never shows the last values for a moment.
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      setValues(valuesOf(contact));
      setMessages({});
      setGeneral(null);
      setFailure(null);
    }
  }

  // After a failed attempt the focus goes to the first field that is wrong (WCAG 3.3.1).
  useEffect(() => {
    if (attempt === 0) return;
    content.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);

  function set(field: ContactField, value: string) {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function codeMessage(code: string): string {
    return isValidationCode(code)
      ? t(`contacts.validation.${code}`)
      : translateProblemCode(translator, code);
  }

  /** Shows the refusal of the server: at a field when it names one, else as one message. */
  function showServerError(error: unknown) {
    const next: Partial<Record<ContactField, string>> = {};
    if (error instanceof ApiError) {
      for (const detail of error.errors) {
        const field = POINTERS[detail.pointer];
        if (field !== undefined && next[field] === undefined)
          next[field] = codeMessage(detail.code);
      }
    }
    setMessages(next);
    setFailure(
      Object.keys(next).length > 0
        ? null
        : messageForError(translator, error, { publicOrigin: me.publicOrigin }),
    );
    setAttempt((count) => count + 1);
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setGeneral(null);
    setFailure(null);
    if (mode === 'create') {
      const checked = validateCreate(values);
      if (checked.body === null) {
        setMessages(
          Object.fromEntries(
            Object.entries(checked.errors).map(([field, code]) => [field, codeMessage(code)]),
          ),
        );
        setAttempt((count) => count + 1);
        return;
      }
      setMessages({});
      setPending(true);
      try {
        const created = await createContact(api, checked.body);
        queryClient.setQueryData(directoryKey('contacts', 'detail', created.id), created);
        refreshContacts(queryClient);
        toast({ title: t('contacts.created'), tone: 'success' });
        onOpenChange(false);
        void navigate({ to: '/contacts/$id', params: { id: created.id } });
      } catch (error) {
        showServerError(error);
      } finally {
        setPending(false);
      }
      return;
    }
    if (contact === undefined) return;
    const checked = validateEdit(values, contact);
    if (checked.body === null) {
      setMessages(
        Object.fromEntries(
          Object.entries(checked.errors).map(([field, code]) => [field, codeMessage(code)]),
        ),
      );
      setGeneral(checked.general === null ? null : codeMessage(checked.general));
      setAttempt((count) => count + 1);
      return;
    }
    setMessages({});
    setPending(true);
    try {
      const saved = await updateContact(api, contact.id, checked.body);
      queryClient.setQueryData(directoryKey('contacts', 'detail', saved.id), saved);
      refreshContacts(queryClient);
      toast({ title: t('contacts.saved'), tone: 'success' });
      onOpenChange(false);
    } catch (error) {
      showServerError(error);
    } finally {
      setPending(false);
    }
  }

  const required = t('contacts.form.required');
  const create = mode === 'create';
  const text = (field: ContactField, label: string, hint?: string, isRequired = true) => (
    <FormField
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(messages[field] === undefined ? {} : { error: messages[field] })}
      required={isRequired}
      requiredLabel={required}
    >
      {(control) => (
        <Input
          {...control}
          value={values[field]}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            set(field, event.target.value);
          }}
        />
      )}
    </FormField>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={create ? t('contacts.form.create.title') : t('contacts.form.edit.title')}
      description={
        create ? t('contacts.form.create.description') : t('contacts.form.edit.description')
      }
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('contacts.form.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={pending}
            aria-busy={pending ? true : undefined}
          >
            {create ? t('contacts.form.create.submit') : t('contacts.form.edit.submit')}
          </Button>
        </>
      }
    >
      <div ref={content}>
        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            void submit(event);
          }}
          className="flex flex-col gap-4"
        >
          {text('displayName', t('contacts.form.displayName'))}
          {text('alias', t('contacts.form.alias'), t('contacts.form.aliasHint'))}
          {text('externalEmailAddress', t('contacts.form.address'), t('contacts.form.addressHint'))}
          {create ? (
            <>
              {text('firstName', t('contacts.form.firstName'), undefined, false)}
              {text('lastName', t('contacts.form.lastName'), undefined, false)}
            </>
          ) : null}
          {general === null ? null : (
            <p role="alert" className="text-body-sm text-danger">
              {general}
            </p>
          )}
          {failure === null ? null : (
            <div role="alert" className="flex flex-col gap-1 text-body-sm">
              <p className="font-medium text-danger">{t('contacts.form.error')}</p>
              <p className="text-fg-secondary">{failure}</p>
            </div>
          )}
        </form>
      </div>
    </Dialog>
  );
}
