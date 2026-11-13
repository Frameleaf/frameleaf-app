import type { PhotographyBulkDto, PhotographyBulkRow } from 'src/dtos/photography-bulk.dto.js';
import type { PhotographyConfig } from 'src/dtos/photography-workflow.dto.js';

type RowView = PhotographyBulkDto['rows'][number];
export type BulkGalleryRow = PhotographyBulkRow & {
  id: string;
  albumId?: string;
  recipientId?: string;
  status: RowView['status'];
  error: RowView['error'];
};
export type BulkGalleryBatch = {
  id: string;
  createdAt: string;
  fingerprint: string;
  template: PhotographyConfig;
  rows: BulkGalleryRow[];
};

export async function bulkInvitation(id: string, hmac: (purpose: string, id: string) => Promise<string>) {
  const [token, password] = await Promise.all([hmac('token', id), hmac('password', id)]);
  return { token: Buffer.from(token, 'base64url').toString('hex'), password: password.slice(0, 20) };
}
