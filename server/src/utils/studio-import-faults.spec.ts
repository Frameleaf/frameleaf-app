import { describe, expect, it, vi } from 'vitest';
import { noImportFaults } from 'src/utils/studio-import-faults.js';
import { IMPORT_FAULT_POINTS, barrierFaults } from 'test/fixtures/studio-import-barrier-faults.js';

describe('test-only barrier controls, without SQL or process crashes', () => {
  it('has eight distinct approved boundaries and an inert production default', async () => {
    expect(new Set(IMPORT_FAULT_POINTS).size).toBe(8);
    for (const point of IMPORT_FAULT_POINTS) await expect(noImportFaults.reached(point)).resolves.toBeUndefined();
  });
  it.each(IMPORT_FAULT_POINTS)('parks only after notifying the selected boundary: %s', async (stop) => {
    const notify = vi.fn(() => Promise.resolve());
    const faults = barrierFaults(stop, notify);
    for (const point of IMPORT_FAULT_POINTS) {
      if (point !== stop) await expect(faults.reached(point)).resolves.toBeUndefined();
    }
    expect(notify).not.toHaveBeenCalled();
    const parked = faults.reached(stop);
    expect(notify).toHaveBeenCalledExactlyOnceWith(stop);
    expect(await Promise.race([parked.then(() => 'unparked'), Promise.resolve('pending')])).toBe('pending');
  });
  it('propagates a failed notification rather than pretending to have parked', async () => {
    const faults = barrierFaults('target-link', () => Promise.reject(new Error('notification_failed')));
    await expect(faults.reached('target-link')).rejects.toThrow('notification_failed');
  });
});
