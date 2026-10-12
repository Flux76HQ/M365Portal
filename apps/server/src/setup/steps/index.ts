// The sub-actions of the wizard, in one list (T-B-129 "the runner executes sub-actions through an
// interface so each sub-action plugs in"). The runner looks them up by (step, key).
import type { SubActionDefinition } from '../context.js';
import { applicationSubAction } from './configure/application.js';
import { applicationSettingsSubAction } from './configure/application-settings.js';
import { certificateSubAction } from './configure/certificate.js';
import { exchangePermissionsSubAction } from './configure/exchange-permissions.js';
import { exchangeRoleSubAction } from './configure/exchange-role.js';
import { graphPermissionsSubAction } from './configure/graph-permissions.js';
import { servicePrincipalSubAction } from './configure/service-principal.js';
import { deviceCodeSubAction } from './connect.js';
import {
  appTokenSubAction,
  auditReadsSubAction,
  exchangeProbeSubAction,
  organizationSubAction,
  usersSubAction,
} from './verify.js';

export function subActionRegistry(): readonly SubActionDefinition[] {
  return [
    deviceCodeSubAction,
    applicationSubAction,
    servicePrincipalSubAction,
    certificateSubAction,
    applicationSettingsSubAction,
    graphPermissionsSubAction,
    exchangePermissionsSubAction,
    exchangeRoleSubAction,
    auditReadsSubAction,
    appTokenSubAction,
    organizationSubAction,
    usersSubAction,
    exchangeProbeSubAction,
  ];
}
