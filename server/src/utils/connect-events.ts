import { type EventV1, WorkflowTrigger } from '@frameleaf/plugin-sdk';
import { createHash } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { toEventPayload } from 'src/utils/workflow-event.js';

export const CONNECT_EVENT_TYPES = ['asset.ready', 'album.asset.added', 'studio.export.completed'] as const;
export type ConnectEventType = (typeof CONNECT_EVENT_TYPES)[number];
export type ConnectEventRow = {
  event: ConnectEventType;
  deliveryId: string;
  occurredAt: Date;
  assetId: string;
  albumId: string | null;
  format: string | null;
};

export const connectEventBinding = (auth: AuthDto) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        auth.user.id,
        auth.oauthApp?.grantId,
        auth.oauthApp?.resource,
        [...(auth.oauthApp?.scopes ?? [])].sort(),
        auth.oauthApp?.policyRevision,
      ]),
    )
    .digest('hex');

export type ConnectEventPayload = Omit<EventV1, 'event' | 'subject'> & {
  event: ConnectEventType;
  subject: { kind: 'asset'; id: string; name: null };
};
export const toConnectEventPayload = (row: ConnectEventRow): ConnectEventPayload => {
  const subject = { kind: 'asset' as const, id: row.assetId, name: null };
  const occurredAt = row.occurredAt.toISOString();
  if (row.event === 'studio.export.completed') {
    const payload = toEventPayload({
      trigger: WorkflowTrigger.StudioExportCompleted,
      ownerId: '',
      deliveryId: row.deliveryId,
      occurredAt,
      subject,
      detail: ['image/jpeg', 'image/heic', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'].includes(
        row.format ?? '',
      )
        ? { format: row.format }
        : {},
    });
    return { ...payload, event: row.event, subject };
  }
  return {
    event: row.event,
    deliveryId: row.deliveryId,
    occurredAt,
    subject,
    detail: row.event === 'album.asset.added' && row.albumId ? { albumId: row.albumId } : {},
  };
};
