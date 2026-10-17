import { getAssetStatistics, getMyUser, getServerVersion, getSupportedMediaTypes, Permission } from '@frameleaf/sdk';
import { authenticate, BaseOptions, requirePermissions } from 'src/utils.js';

export const serverInfo = async (options: BaseOptions) => {
  const { url } = await authenticate(options);
  await requirePermissions([Permission.ServerAbout, Permission.AssetStatistics, Permission.UserRead]);

  const [versionInfo, mediaTypes, stats, userInfo] = await Promise.all([
    getServerVersion(),
    getSupportedMediaTypes(),
    getAssetStatistics({}),
    getMyUser(),
  ]);

  console.log(
    [
      `Server Info (via ${userInfo.email})`,
      `  Url: ${url}`,
      `  Version: ${versionInfo.major}.${versionInfo.minor}.${versionInfo.patch}`,
      '  Formats:',
      `    Images: ${mediaTypes.image.map((extension) => extension.replace('.', ''))}`,
      `    Videos: ${mediaTypes.video.map((extension) => extension.replace('.', ''))}`,
      '  Statistics:',
      `    Images: ${stats.images}`,
      `    Videos: ${stats.videos}`,
      `    Total: ${stats.total}`,
    ].join('\n'),
  );
};
