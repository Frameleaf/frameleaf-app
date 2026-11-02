import { describe, expect, it } from 'vitest';
import { cloudCustomerCost, estimateResponseSchema } from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

describe('promotional customer cost', () => {
  it('preserves gross cost and uses the net confirmed spending amounts, including zero', () => {
    const raw = cloudContractFixture('ml/estimate-response.json');
    const base = estimateResponseSchema.parse(raw);
    expect(cloudCustomerCost(base)).toEqual(base.cost);
    const quoted = estimateResponseSchema.parse({
      ...base,
      promotion: {
        campaignId: '00000000-0000-4000-8000-000000000001',
        discountP50: base.cost.p50,
        discountP90: base.cost.p90,
        netP50: 0,
        netP90: 0,
        netHold: 0,
        finalAtAdmission: true,
      },
    });
    expect(cloudCustomerCost(quoted)).toEqual({ ...base.cost, p50: 0, p90: 0, hold: 0 });
    expect(quoted.cost).toEqual(base.cost);
  });
  it('rejects promotional totals above the gross quote', () => {
    const base = estimateResponseSchema.parse(cloudContractFixture('ml/estimate-response.json'));
    expect(
      estimateResponseSchema.safeParse({
        ...base,
        promotion: {
          campaignId: '00000000-0000-4000-8000-000000000001',
          discountP50: 0,
          discountP90: 0,
          netP50: base.cost.p50 + 1,
          netP90: base.cost.p90 + 1,
          netHold: base.cost.hold + 1,
          finalAtAdmission: true,
        },
      }).success,
    ).toBe(false);
  });
});
