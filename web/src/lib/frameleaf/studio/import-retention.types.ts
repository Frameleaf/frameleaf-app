/** Checked by the existing web check:typescript source include after canonical SDK generation. */
import type { StudioProjectImportDto } from '@frameleaf/sdk';
import type { RetainedProcessingProvenance } from './host-contract';

type CanonicalRetained = NonNullable<StudioProjectImportDto['processingProvenance']>;
export const retainedSdkToHost = (value: CanonicalRetained): RetainedProcessingProvenance => value;
export const retainedHostToSdk = (value: RetainedProcessingProvenance): CanonicalRetained => value;
