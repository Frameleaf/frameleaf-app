import {
  type EventV1,
  FRAMELEAF_EVENT_TRIGGERS,
  type FrameleafEventTrigger,
  WorkflowTrigger,
} from '@frameleaf/plugin-sdk';
import { createHash, createHmac } from 'node:crypto';

/**
 * FL-819: things that happen in Frameleaf itself rather than to one photo. Each one starts its owner's
 * workflows that run on it, and those can only send it to a web address (the webhook step).
 *
 * What a receiver gets is `EventV1`: the event name, a delivery id that stays the same for one
 * occurrence, when it happened, what it is about and a few listed details. Nothing else leaves: no
 * photo of the owner's or anyone else's, no file path, no credential and no free text a person typed
 * other than the subject's own name.
 */
export type FrameleafEventOccurrence = {
  trigger: FrameleafEventTrigger;
  /** The account the event belongs to: only that account's workflows run on it. */
  ownerId: string;
  /** Stable for one occurrence, so a second report of it starts nothing new. */
  deliveryId: string;
  occurredAt: string;
  subject: EventV1['subject'];
  detail: Record<string, unknown>;
  /**
   * Photos or videos the event is about. They are never sent; the event is dropped while any of them
   * is Locked, hidden or sensitive, so a message never tells of something private.
   */
  privacyAssetIds?: string[];
};

type DetailValue = string | number | boolean | null;

/** The event name a receiver sees, and the only detail fields each event may carry. */
export const FRAMELEAF_EVENTS: Record<FrameleafEventTrigger, { event: string; detail: readonly string[] }> = {
  [WorkflowTrigger.StudioExportCompleted]: { event: 'studio.export.completed', detail: ['projectId', 'format'] },
  [WorkflowTrigger.CloudBackupCompleted]: {
    event: 'cloud.backup.completed',
    detail: ['uploaded', 'alreadyBackedUp', 'missing', 'bytesUploaded', 'startedAt'],
  },
  [WorkflowTrigger.CloudBackupFailed]: {
    event: 'cloud.backup.failed',
    detail: ['uploaded', 'alreadyBackedUp', 'missing', 'bytesUploaded', 'startedAt'],
  },
  [WorkflowTrigger.ClientsGalleryApproved]: { event: 'clients.gallery.approved', detail: ['chosen', 'round'] },
  [WorkflowTrigger.CloudJobCompleted]: { event: 'cloud.job.completed', detail: ['job', 'stage'] },
};

export const isFrameleafEventTrigger = (trigger: string): trigger is FrameleafEventTrigger =>
  (FRAMELEAF_EVENT_TRIGGERS as readonly string[]).includes(trigger);

const isDetailValue = (value: unknown): value is DetailValue =>
  value === null ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length <= 200);

/** What the webhook step sends: only the listed fields of the event, never the photos it was about. */
export const toEventPayload = (occurrence: FrameleafEventOccurrence): EventV1 => {
  const { event, detail: allowed } = FRAMELEAF_EVENTS[occurrence.trigger];
  const detail: EventV1['detail'] = {};
  for (const key of allowed) {
    const value = occurrence.detail[key];
    if (isDetailValue(value)) {
      detail[key] = value;
    }
  }
  return {
    event,
    deliveryId: occurrence.deliveryId,
    occurredAt: occurrence.occurredAt,
    subject: {
      kind: occurrence.subject.kind,
      id: occurrence.subject.id,
      name: occurrence.subject.name?.slice(0, 200) ?? null,
    },
    detail,
  };
};

/** A UUID-shaped id derived from `parts`: the same occurrence and workflow always give the same id. */
export const derivedId = (...parts: string[]): string => {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The run of `workflowId` for one occurrence; queuing it again adds no second run. */
export const eventRunIds = (workflowId: string, deliveryId: string) => ({
  runId: derivedId('workflow-event-run', workflowId, deliveryId),
  executionId: derivedId('workflow-event-execution', workflowId, deliveryId),
});

/**
 * Signs `${timestamp}.${deliveryId}.${body}` (`X-Frameleaf-Signature`), so a receiver can check the
 * message, when it was sent and which delivery it is; a replay cannot change any of them.
 */
export const signEventBody = (secret: string, timestamp: string, deliveryId: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex')}`;
