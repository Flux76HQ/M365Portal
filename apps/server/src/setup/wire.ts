// The wire types of the setup and connection routes, inferred from the shared schemas (CB14) so the
// server and the web client cannot disagree about a shape. Types only.
import type {
  AdoptionPromptSchema,
  ConnectionResponseSchema,
  DeviceCodePanelSchema,
  RunSnapshotSchema,
  RunStatusSchema,
} from '@m365portal/shared/schemas/connection';
import type { z } from 'zod';

export type AdoptionPrompt = z.infer<typeof AdoptionPromptSchema>;
export type DeviceCodePanel = z.infer<typeof DeviceCodePanelSchema>;
export type RunStatusWire = z.infer<typeof RunStatusSchema>;
export type RunSnapshotWire = z.infer<typeof RunSnapshotSchema>;
export type ConnectionWire = z.infer<typeof ConnectionResponseSchema>;
