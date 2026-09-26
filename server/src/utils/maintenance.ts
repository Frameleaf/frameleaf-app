import { SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { MaintenanceAuthDto, MaintenanceDetectInstallResponseDto } from 'src/dtos/maintenance.dto.js';
import { StorageFolder } from 'src/enum.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';

/**
 * The maintenance login address. FL-190: without a public address (`baseUrl` undefined) it is a path
 * to open on the server's own address, never another project's host.
 */
export async function createMaintenanceLoginUrl(
  baseUrl: string | undefined,
  auth: MaintenanceAuthDto,
  secret: string,
): Promise<string> {
  return `${baseUrl ?? ''}/maintenance?token=${await signMaintenanceJwt(secret, auth)}`;
}

/** How to use a maintenance login address: a full URL, or a path to open on the server's address. */
export const maintenanceLoginHint = (url: string) =>
  url.startsWith('/')
    ? 'Log in by opening this path on your server (no external domain is set)'
    : 'Log in using the following URL';

export async function signMaintenanceJwt(secret: string, data: MaintenanceAuthDto): Promise<string> {
  const alg = 'HS256';

  return await new SignJWT({ ...data })
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setExpirationTime('4h')
    .sign(new TextEncoder().encode(secret));
}

export function generateMaintenanceSecret(): string {
  return randomBytes(64).toString('hex');
}

export async function detectPriorInstall(
  storageRepository: StorageRepository,
): Promise<MaintenanceDetectInstallResponseDto> {
  return {
    storage: await Promise.all(
      Object.values(StorageFolder).map(async (folder) => {
        const path = StorageCore.getBaseFolder(folder);
        const files = await storageRepository.readdir(path);
        const filename = join(StorageCore.getBaseFolder(folder), '.immich');

        let isReadable = false,
          isWritable = false;

        try {
          await storageRepository.readFile(filename);
          isReadable = true;

          await storageRepository.overwriteFile(filename, Buffer.from(Date.now().toString()));
          isWritable = true;
        } catch {
          // no-op
        }

        return {
          folder,
          readable: isReadable,
          writable: isWritable,
          files: files.filter((fn) => fn !== '.immich').length,
        };
      }),
    ),
  };
}
