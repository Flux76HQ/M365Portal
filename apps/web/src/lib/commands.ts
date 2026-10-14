// The command registry (FR-A-127, FR-A-129, plan 9.1, PD-18): one list that the sidebar, the command
// palette and the header's search trigger all read, so what the palette offers and what the menu
// shows cannot drift apart.
//
// An entry has an id, a label and keywords (catalogue keys, never text), an icon, what happens when
// it runs (go to a page, or an action the shell carries out) and the permissions of which the actor
// needs at least one. `visibleCommands(me)` is a pure function of `me`: the same actor always gets the
// same list. Gating is cosmetic (the server enforces every permission); this only decides what is
// offered, deny by default.
//
// Scope filtering (what an actor may do with which tenant object) joins in Phases B and D; the shape
// has room for it in `anyOf`.
import type { MessageKey } from '@m365portal/shared/i18n';
import type { Locale } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import { ROUTES, type ClientPath } from '@m365portal/shared/routes';
import {
  BookOpenIcon,
  ContactIcon,
  FolderTreeIcon,
  GaugeIcon,
  KeyboardIcon,
  LifeBuoyIcon,
  LanguagesIcon,
  ListIcon,
  MonitorCogIcon,
  MoonIcon,
  PaletteIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SunIcon,
  UnplugIcon,
  UserRoundCogIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import type { MeResponse } from './boot-data';
import { hasAccess } from './gating';
import type { ThemeChoice } from './theme';

/** What happens when a command runs. The shell carries out the actions (components/shell/run-command.ts). */
export type CommandRun =
  | { readonly kind: 'navigate'; readonly to: ClientPath }
  | { readonly kind: 'theme'; readonly choice: ThemeChoice }
  | { readonly kind: 'language'; readonly language: Locale }
  | { readonly kind: 'shortcuts' };

/** Where a command is listed in the palette. */
export type CommandGroup = 'navigate' | 'preferences' | 'help';

/** The kinds of actor `me` names (`MeResponse.actor.kind`). */
export type ActorKind = MeResponse['actor']['kind'];

/** Who is signed in: a Microsoft user or the break-glass session. */
const SIGNED_IN: readonly ActorKind[] = ['user', 'break_glass'];

export interface Command {
  /** Stable, unique; also the `value` the palette selects by. */
  readonly id: string;
  /** The label, in the sidebar and in the palette. */
  readonly labelKey: MessageKey;
  /** Words that find the command besides its label; searched in both languages. */
  readonly keywordKeys: readonly MessageKey[];
  readonly icon: LucideIcon;
  readonly run: CommandRun;
  readonly group: CommandGroup;
  /** Listed in the sidebar. Only destinations are; actions and nested pages are palette-only. */
  readonly sidebar?: boolean;
  /**
   * The actor needs at least one of these. Absent: no permission is needed (the dashboard, the
   * preferences). Present but empty: nobody qualifies (deny by default).
   */
  readonly anyOf?: readonly Permission[];
  /**
   * The kind of actor the command is for (T-B-306): `user` and `break_glass` are the signed-in actors, and a
   * command for them is not offered to the setup session or to a visitor. Both this and `anyOf` must hold.
   * Absent: any actor. A command with a list but no actor to read is hidden (deny by default).
   */
  readonly actorKinds?: readonly ActorKind[];
  /** Offered only while the server reports this feature on. */
  readonly feature?: keyof MeResponse['features'];
}

/** Every command of Phase A, in the order the sidebar shows them. */
export const COMMANDS: readonly Command[] = Object.freeze([
  {
    id: 'dashboard',
    labelKey: 'nav.dashboard',
    keywordKeys: ['palette.keywords.dashboard'],
    icon: GaugeIcon,
    run: { kind: 'navigate', to: ROUTES.dashboard },
    group: 'navigate',
    sidebar: true,
  },
  {
    id: 'users',
    labelKey: 'nav.users',
    keywordKeys: ['palette.keywords.users'],
    icon: UsersIcon,
    run: { kind: 'navigate', to: ROUTES.users },
    group: 'navigate',
    sidebar: true,
    anyOf: ['users:read'],
  },
  {
    id: 'groups',
    labelKey: 'nav.groups',
    keywordKeys: ['palette.keywords.groups'],
    icon: FolderTreeIcon,
    run: { kind: 'navigate', to: ROUTES.groups },
    group: 'navigate',
    sidebar: true,
    anyOf: ['groups:read'],
  },
  {
    id: 'distribution-lists',
    labelKey: 'nav.distributionLists',
    keywordKeys: ['palette.keywords.distributionLists'],
    icon: ListIcon,
    run: { kind: 'navigate', to: ROUTES.distributionLists },
    group: 'navigate',
    sidebar: true,
    anyOf: ['distributionlists:read'],
  },
  {
    id: 'contacts',
    labelKey: 'nav.contacts',
    keywordKeys: ['palette.keywords.contacts'],
    icon: ContactIcon,
    run: { kind: 'navigate', to: ROUTES.contacts },
    group: 'navigate',
    sidebar: true,
    anyOf: ['contacts:read'],
  },
  {
    id: 'audit',
    labelKey: 'nav.auditLog',
    keywordKeys: ['palette.keywords.auditLog'],
    icon: ScrollTextIcon,
    run: { kind: 'navigate', to: ROUTES.auditLog },
    group: 'navigate',
    sidebar: true,
    anyOf: ['audit:read'],
  },
  {
    id: 'settings',
    labelKey: 'nav.settings',
    keywordKeys: ['palette.keywords.settings'],
    icon: SettingsIcon,
    run: { kind: 'navigate', to: ROUTES.settings },
    group: 'navigate',
    sidebar: true,
    // Every signed-in actor has Settings: "Mijn toegang" is theirs. The overview lists only what they may open.
    actorKinds: SIGNED_IN,
  },
  {
    id: 'settings-appearance',
    labelKey: 'palette.command.settingsAppearance',
    keywordKeys: ['palette.keywords.appearance'],
    icon: PaletteIcon,
    run: { kind: 'navigate', to: ROUTES.appearance },
    group: 'navigate',
    anyOf: ['settings:branding'],
    // The wizard's session holds this permission too, but it sits on the setup page, not in the Settings.
    actorKinds: ['user'],
  },
  {
    id: 'settings-connection',
    labelKey: 'palette.command.settingsConnection',
    keywordKeys: ['palette.keywords.connection'],
    icon: UnplugIcon,
    run: { kind: 'navigate', to: ROUTES.connection },
    group: 'navigate',
    anyOf: ['settings:connection'],
    actorKinds: ['user'],
  },
  {
    id: 'settings-access',
    labelKey: 'palette.command.settingsAccess',
    keywordKeys: ['palette.keywords.access'],
    icon: ShieldCheckIcon,
    run: { kind: 'navigate', to: ROUTES.access },
    group: 'navigate',
    actorKinds: SIGNED_IN,
  },
  {
    id: 'settings-roles',
    labelKey: 'palette.command.settingsRoles',
    keywordKeys: ['palette.keywords.roles'],
    icon: UserRoundCogIcon,
    run: { kind: 'navigate', to: ROUTES.roles },
    group: 'navigate',
    anyOf: ['rbac:manage'],
    // The break-glass session holds this permission too, but it can only restore an Owner (its own page).
    actorKinds: ['user'],
  },
  {
    id: 'settings-restore-access',
    labelKey: 'palette.command.settingsRestoreAccess',
    keywordKeys: ['palette.keywords.restoreAccess'],
    icon: LifeBuoyIcon,
    run: { kind: 'navigate', to: ROUTES.restoreAccess },
    group: 'navigate',
    actorKinds: ['break_glass'],
  },
  {
    id: 'design',
    labelKey: 'nav.design',
    keywordKeys: ['palette.keywords.design'],
    icon: BookOpenIcon,
    run: { kind: 'navigate', to: ROUTES.design },
    group: 'navigate',
    sidebar: true,
    feature: 'showcase',
  },
  {
    id: 'theme-light',
    labelKey: 'palette.command.themeLight',
    keywordKeys: ['palette.keywords.themeLight'],
    icon: SunIcon,
    run: { kind: 'theme', choice: 'light' },
    group: 'preferences',
  },
  {
    id: 'theme-dark',
    labelKey: 'palette.command.themeDark',
    keywordKeys: ['palette.keywords.themeDark'],
    icon: MoonIcon,
    run: { kind: 'theme', choice: 'dark' },
    group: 'preferences',
  },
  {
    id: 'theme-system',
    labelKey: 'palette.command.themeSystem',
    keywordKeys: ['palette.keywords.themeSystem'],
    icon: MonitorCogIcon,
    run: { kind: 'theme', choice: 'system' },
    group: 'preferences',
  },
  {
    id: 'language-nl',
    labelKey: 'palette.command.languageNl',
    keywordKeys: ['palette.keywords.languageNl'],
    icon: LanguagesIcon,
    run: { kind: 'language', language: 'nl' },
    group: 'preferences',
  },
  {
    id: 'language-en',
    labelKey: 'palette.command.languageEn',
    keywordKeys: ['palette.keywords.languageEn'],
    icon: LanguagesIcon,
    run: { kind: 'language', language: 'en' },
    group: 'preferences',
  },
  {
    id: 'shortcuts',
    labelKey: 'palette.command.shortcuts',
    keywordKeys: ['palette.keywords.shortcuts'],
    icon: KeyboardIcon,
    run: { kind: 'shortcuts' },
    group: 'help',
  },
] satisfies readonly Command[]);

/** What `visibleCommands` reads of `me`: the permissions and the feature flags. */
export type CommandActor = Pick<MeResponse, 'permissions' | 'features'> & {
  readonly actor?: Pick<MeResponse['actor'], 'kind'>;
};

function isVisible(command: Command, me: CommandActor): boolean {
  if (command.feature !== undefined && !me.features[command.feature]) return false;
  if (
    command.actorKinds !== undefined &&
    !(me.actor !== undefined && command.actorKinds.includes(me.actor.kind))
  ) {
    return false;
  }
  return command.anyOf === undefined || hasAccess(me, command.anyOf);
}

/**
 * Everything this actor may be offered (destinations and actions), in registry order. Pure: the same
 * `me` always gives the same list, and `me` is not changed. `commands` is a parameter so a test can
 * hand in its own list.
 */
export function visibleCommands(
  me: CommandActor,
  commands: readonly Command[] = COMMANDS,
): readonly Command[] {
  return commands.filter((command) => isVisible(command, me));
}

/** The destinations of the sidebar for this actor. */
export function navigationCommands(me: CommandActor): readonly Command[] {
  return visibleCommands(me).filter((command) => command.sidebar === true);
}
