import { PushDeviceRepository } from 'src/repositories/push-device.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('push delivery activity grouping', () => {
  it('groups an ordered batch without rescanning every activity for every device', async () => {
    const devices = Array.from({ length: 51 }, (_, index) => ({ id: `device-${index}`, userId: 'owner' }));
    let identityReads = 0;
    const activities = Array.from({ length: 200 }, (_, index) => ({
      id: `activity-${index}`,
      get deviceId() {
        identityReads++;
        return `device-${index % 50}`;
      },
    }));
    const { db } = scriptedKysely(({ sql }) => ({
      rows: sql.includes('from "push_device_activity"') ? activities : devices,
    }));
    const sut = new PushDeviceRepository(db);
    const result = await sut.getDeliveryTargets(['00000000-0000-4000-8000-000000000001']);
    expect(result.map(({ id }) => id)).toEqual(devices.map(({ id }) => id));
    expect(result[0].activities.map(({ id }) => id)).toEqual([
      'activity-0',
      'activity-50',
      'activity-100',
      'activity-150',
    ]);
    expect(result[49].activities.map(({ id }) => id)).toEqual([
      'activity-49',
      'activity-99',
      'activity-149',
      'activity-199',
    ]);
    expect(result[50].activities).toEqual([]);
    // Count row visits, not machine-dependent timings: grouping must stay linear in the batch.
    expect(identityReads).toBeLessThanOrEqual(activities.length * 2);
  });
});
