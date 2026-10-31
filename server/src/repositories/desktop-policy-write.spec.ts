import { SystemMetadataKey } from 'src/enum.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';

it('requires the config transaction for desktop pool policy writes', async () => {
  const metadata = new SystemMetadataRepository({} as never);
  await expect(metadata.set('frameleaf-desktop-assistance' as SystemMetadataKey, {})).rejects.toThrow(
    'effective_config_transaction_required',
  );
});
it('cannot delete the desktop policy key and silently lose the selected pool', async () => {
  const metadata = new SystemMetadataRepository({} as never);
  await expect(metadata.delete('frameleaf-desktop-assistance' as SystemMetadataKey)).rejects.toThrow(
    'effective_config_delete_refused',
  );
});
