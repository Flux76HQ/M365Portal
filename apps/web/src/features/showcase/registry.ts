// The coverage matrix of the showcase (FR-A-124, FR-A-131): every component of the library and the states it
// is shown in. `test/showcase.test.tsx` states the list of FR-A-124 again and compares it with this one,
// and compares this one with what the page really draws, so neither can drift from the other.
//
// A state is a name for how a component looks and behaves: `hover` and `focus` are drawn with forced
// classes (no pointer needed, which is also what the visual regression run needs); `open` is the trigger of
// an overlay, which the page opens when it is used.
import type { MessageKey } from '@m365portal/shared/i18n';

export type ShowcaseState =
  | 'default'
  | 'hover'
  | 'focus'
  | 'disabled'
  | 'invalid'
  | 'loading'
  | 'empty'
  | 'error'
  | 'open'
  | 'ready'
  | 'no-results'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';

export const STATE_KEYS = {
  default: 'showcase.state.default',
  hover: 'showcase.state.hover',
  focus: 'showcase.state.focus',
  disabled: 'showcase.state.disabled',
  invalid: 'showcase.state.invalid',
  loading: 'showcase.state.loading',
  empty: 'showcase.state.empty',
  error: 'showcase.state.error',
  open: 'showcase.state.open',
  ready: 'showcase.state.ready',
  'no-results': 'showcase.state.noResults',
  info: 'showcase.state.info',
  success: 'showcase.state.success',
  warning: 'showcase.state.warning',
  danger: 'showcase.state.danger',
} as const satisfies Record<ShowcaseState, MessageKey>;

export interface ShowcaseComponent {
  readonly id: string;
  readonly nameKey: MessageKey;
  readonly states: readonly ShowcaseState[];
}

export const SHOWCASE_COMPONENTS: readonly ShowcaseComponent[] = Object.freeze([
  { id: 'button', nameKey: 'showcase.component.button', states: ['default', 'hover', 'focus', 'disabled', 'loading'] },
  { id: 'icon-button', nameKey: 'showcase.component.iconButton', states: ['default', 'hover', 'focus', 'disabled'] },
  { id: 'input', nameKey: 'showcase.component.input', states: ['default', 'focus', 'disabled', 'invalid'] },
  { id: 'textarea', nameKey: 'showcase.component.textarea', states: ['default', 'focus', 'disabled', 'invalid'] },
  { id: 'select', nameKey: 'showcase.component.select', states: ['default', 'focus', 'disabled', 'invalid'] },
  { id: 'checkbox', nameKey: 'showcase.component.checkbox', states: ['default', 'focus', 'disabled', 'invalid'] },
  { id: 'radio-group', nameKey: 'showcase.component.radioGroup', states: ['default', 'focus', 'disabled', 'invalid'] },
  { id: 'switch', nameKey: 'showcase.component.switch', states: ['default', 'focus', 'disabled'] },
  { id: 'segmented-control', nameKey: 'showcase.component.segmentedControl', states: ['default', 'hover', 'focus', 'disabled'] },
  { id: 'tabs', nameKey: 'showcase.component.tabs', states: ['default', 'hover', 'focus', 'disabled'] },
  { id: 'menu', nameKey: 'showcase.component.menu', states: ['open'] },
  { id: 'tooltip', nameKey: 'showcase.component.tooltip', states: ['open'] },
  { id: 'dialog', nameKey: 'showcase.component.dialog', states: ['open'] },
  { id: 'confirm-dialog', nameKey: 'showcase.component.confirmDialog', states: ['open'] },
  { id: 'toast', nameKey: 'showcase.component.toast', states: ['open'] },
  { id: 'banner', nameKey: 'showcase.component.banner', states: ['info', 'success', 'warning', 'danger'] },
  { id: 'breadcrumbs', nameKey: 'showcase.component.breadcrumbs', states: ['default'] },
  { id: 'command-bar', nameKey: 'showcase.component.commandBar', states: ['default', 'disabled'] },
  { id: 'details-panel', nameKey: 'showcase.component.detailsPanel', states: ['open'] },
  { id: 'command-palette', nameKey: 'showcase.component.commandPalette', states: ['open'] },
  { id: 'persona', nameKey: 'showcase.component.persona', states: ['default'] },
  { id: 'skeleton', nameKey: 'showcase.component.skeleton', states: ['loading'] },
  { id: 'empty-state', nameKey: 'showcase.component.emptyState', states: ['empty'] },
  { id: 'error-state', nameKey: 'showcase.component.errorState', states: ['error'] },
  { id: 'data-table', nameKey: 'showcase.component.dataTable', states: ['loading', 'ready', 'empty', 'no-results', 'error'] },
  { id: 'form-field', nameKey: 'showcase.component.formField', states: ['default', 'disabled', 'invalid'] },
] satisfies readonly ShowcaseComponent[]);

export function componentById(id: string): ShowcaseComponent {
  const found = SHOWCASE_COMPONENTS.find((component) => component.id === id);
  if (found === undefined) throw new Error(`the showcase has no component "${id}"`);
  return found;
}
