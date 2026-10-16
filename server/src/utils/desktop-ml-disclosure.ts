import { createHash } from 'node:crypto';
import z from 'zod';
import type { MlEndpoint } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationKind } from 'src/enum.js';
import { assetSourceSnapshotSchema } from 'src/utils/asset-source-authority.js';
import { canonicalJson } from 'src/utils/object.js';

export const desktopMlDisclosureSchema = z.strictObject({
  version: z.literal(1),
  source: assetSourceSnapshotSchema,
  policyRevision: z.uuid(),
  routeRevision: z.uuid(),
  destinationId: z.uuid(),
  kind: z.enum([MlDestinationKind.Local, MlDestinationKind.Lan]),
  endpointSha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelName: z.string().min(1).max(256),
  indexRevision: z.uuid(),
  spaceKey: z.string().min(1).max(256),
  job: z.strictObject({ id: z.uuid(), token: z.uuid() }),
});
export type DesktopMlDisclosure = z.infer<typeof desktopMlDisclosureSchema>;
export const desktopEndpointDigest = (endpoint: Pick<MlEndpoint, 'url' | 'authToken'>) =>
  createHash('sha256')
    .update(canonicalJson({ url: endpoint.url, authToken: endpoint.authToken ?? null }))
    .digest('hex');
