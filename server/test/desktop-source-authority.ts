import type { AssetSourceSnapshot } from 'src/utils/asset-source-authority.js';

export const desktopSourceSnapshot = (ownerId: string): AssetSourceSnapshot => ({
  assetId: ownerId,
  ownerId,
  checksum: '01',
  derivatives: true,
  revision: {},
});
