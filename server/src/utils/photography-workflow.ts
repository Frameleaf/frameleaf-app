import { BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type DeliveryItem = {
  captureId: string;
  revisionId: string | null;
  approved: boolean;
  finalPath: string | null;
};
export type DeliveryOrder = { recipientId: string; status: string; items: DeliveryItem[] };
export function deliveryBlock(
  recipient: { canDownload: boolean; captureIds: string[] | null },
  recipientId: string,
  captureId: string,
  orders: DeliveryOrder[],
): 'permission' | 'order' | 'payment' | 'approval' | 'render' | null {
  if (!recipient.canDownload || (recipient.captureIds && !recipient.captureIds.includes(captureId)))
    return 'permission';
  const matching = orders.filter(
    (order) => order.recipientId === recipientId && order.items.some((item) => item.captureId === captureId),
  );
  if (matching.length === 0) return 'order';
  const paid = matching.filter((order) => ['settled', 'free'].includes(order.status));
  if (paid.length === 0) return 'payment';
  const approved = paid
    .flatMap((order) => order.items)
    .filter((item) => item.captureId === captureId && item.approved && item.revisionId);
  if (approved.length === 0) return 'approval';
  return approved.some((item) => item.finalPath) ? null : 'render';
}
export function priceSelection(
  config: {
    includedCount: number;
    additionalPrice: number;
    collectionPrice: number | null;
    bundles: { count: number; price: number }[];
  },
  count: number,
  pricing: 'package' | 'collection' | 'bundle',
  bundleCount?: number,
): number {
  const price =
    pricing === 'collection'
      ? config.collectionPrice
      : pricing === 'bundle'
        ? config.bundles.find((bundle) => bundle.count === bundleCount && count <= bundle.count)?.price
        : Math.max(0, count - config.includedCount) * config.additionalPrice;
  if (price === null || price === undefined || !Number.isSafeInteger(price) || price < 0 || price > 100_000_000)
    throw new BadRequestException('The selected pricing option is unavailable');
  return price;
}
export function verifyStripeSignature(
  raw: Buffer,
  signature: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = signature.split(',').map((part) => part.split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300) return false;
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  return parts.some(
    ([key, value]) =>
      key === 'v1' && /^[a-f0-9]{64}$/.test(value ?? '') && timingSafeEqual(digest, Buffer.from(value, 'hex')),
  );
}
