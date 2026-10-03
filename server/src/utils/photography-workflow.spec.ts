import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deliveryBlock, priceSelection, verifyStripeSignature } from 'src/utils/photography-workflow.js';

describe('photography release boundary', () => {
  const recipient = { canDownload: true, captureIds: null };
  const item = { captureId: 'capture', revisionId: 'pinned', approved: true, finalPath: '/edited' };
  const order = { recipientId: 'recipient', status: 'settled', items: [item] };
  it('proof access and a settled unrelated order cannot release a photo', () => {
    expect(deliveryBlock({ ...recipient, canDownload: false }, 'recipient', 'capture', [order])).toBe('permission');
    expect(deliveryBlock(recipient, 'recipient', 'other', [order])).toBe('order');
    expect(deliveryBlock(recipient, 'other', 'capture', [order])).toBe('order');
  });
  it('requires every release gate and preserves the pinned revision', () => {
    expect(deliveryBlock(recipient, 'recipient', 'capture', [order])).toBe(null);
    expect(deliveryBlock(recipient, 'recipient', 'capture', [{ ...order, status: 'refunded' }])).toBe('payment');
    expect(
      deliveryBlock(recipient, 'recipient', 'capture', [{ ...order, items: [{ ...item, approved: false }] }]),
    ).toBe('approval');
    expect(
      deliveryBlock(recipient, 'recipient', 'capture', [{ ...order, items: [{ ...item, finalPath: null }] }]),
    ).toBe('render');
    expect(deliveryBlock({ ...recipient, captureIds: ['other'] }, 'recipient', 'capture', [order])).toBe('permission');
  });
  it('prices included, additional, bundle and collection choices in integer minor units', () => {
    const config = {
      includedCount: 2,
      additionalPrice: 1500,
      collectionPrice: 5000,
      bundles: [{ count: 5, price: 4000 }],
    };
    expect(priceSelection(config, 4, 'package')).toBe(3000);
    expect(priceSelection(config, 4, 'collection')).toBe(5000);
    expect(priceSelection(config, 5, 'bundle', 5)).toBe(4000);
    expect(() => priceSelection(config, 6, 'bundle', 5)).toThrow();
  });
  it('rejects forged, stale and body-mutated callbacks', () => {
    const raw = Buffer.from('{"type":"checkout.session.completed"}');
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', 'secret').update(`${timestamp}.`).update(raw).digest('hex');
    expect(verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, 'secret', timestamp)).toBe(true);
    expect(verifyStripeSignature(Buffer.from('{}'), `t=${timestamp},v1=${digest}`, 'secret', timestamp)).toBe(false);
    expect(verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, 'secret', timestamp + 301)).toBe(false);
    expect(verifyStripeSignature(raw, 'v1=invalid', 'secret', timestamp)).toBe(false);
  });
});
