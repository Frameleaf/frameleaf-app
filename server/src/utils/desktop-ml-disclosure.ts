import { createHash } from 'node:crypto';
import z from 'zod';
import type { MlEndpoint } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationKind } from 'src/enum.js';
import { assetSourceSnapshotSchema } from 'src/utils/asset-source-authority.js';
import { canonicalJson } from 'src/utils/object.js';

const common = {
  source: assetSourceSnapshotSchema,
  policyRevision: z.uuid(),
  routeRevision: z.uuid(),
  destinationId: z.uuid(),
  kind: z.enum([MlDestinationKind.Local, MlDestinationKind.Lan]),
  endpointSha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelName: z.string().min(1).max(256),
  job: z.strictObject({ id: z.uuid(), token: z.uuid() }),
};
export const desktopMlDisclosureSchema = z.discriminatedUnion('version', [
  z.strictObject({ ...common, version: z.literal(1), indexRevision: z.uuid(), spaceKey: z.string().min(1).max(256) }),
  z.strictObject({
    ...common,
    version: z.literal(2),
    workload: z.literal('ocr'),
    modelKey: z.string().regex(/^ocr:[a-f0-9]{64}$/),
    ocr: z.strictObject({
      enabled: z.boolean(),
      modelName: z.string().min(1).max(128),
      minDetectionScore: z.number().min(0).max(1),
      minRecognitionScore: z.number().min(0).max(1),
      maxResolution: z.number().int().positive(),
      documentFields: z.boolean(),
    }),
  }),
  z.strictObject({
    ...common,
    version: z.literal(3),
    workload: z.literal('face'),
    modelKey: z.string().regex(/^face:[a-f0-9]{64}$/),
    face: z.strictObject({
      enabled: z.boolean(),
      modelName: z.string().min(1).max(128),
      minScore: z.number().min(0.1).max(1),
      maxDistance: z.number().min(0.1).max(2),
      minFaces: z.number().int().positive(),
    }),
  }),
]);
export type DesktopMlDisclosure = z.infer<typeof desktopMlDisclosureSchema>;
export const desktopEndpointDigest = (endpoint: Pick<MlEndpoint, 'url' | 'authToken'>) =>
  createHash('sha256')
    .update(canonicalJson({ url: endpoint.url, authToken: endpoint.authToken ?? null }))
    .digest('hex');
