import { describe, expect, it } from 'vitest';
import { sourceKinds } from './manifest.js';
import { qualificationTargets } from './qualification.js';

describe('combined library import release boundary', () => {
  it('tracks exactly the ten approved source families', () => {
    expect(Object.keys(qualificationTargets).sort()).toEqual([...sourceKinds].sort());
    expect(sourceKinds).toHaveLength(10);
    expect(sourceKinds).not.toContain('photostructure');
  });
  it('does not advertise research targets as qualified migration support', () => {
    expect(qualificationTargets.synology).toBeNull();
    expect(qualificationTargets.ente).toBeNull();
  });
});
