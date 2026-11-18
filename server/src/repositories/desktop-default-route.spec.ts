import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';

const selection = {
  destinationId: 'nas',
  kind: MlDestinationKind.Local,
  endpoint: { url: 'https://nas.invalid' },
} as MlSelection;
it('refuses a destination disabled after a desktop was selected for its work', async () => {
  const query = {
    selectAll: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    $if: vi.fn().mockReturnThis(),
    executeTakeFirst: vi
      .fn()
      .mockResolvedValue({ id: 'nas', kind: MlDestinationKind.Local, enabled: false, workloads: [MlWorkload.Clip] }),
  };
  const repository = new MlDestinationRepository({ selectFrom: () => query } as never);
  await expect(repository.assertDesktopDestination(selection)).rejects.toThrow('desktop_pool_destination_changed');
});
