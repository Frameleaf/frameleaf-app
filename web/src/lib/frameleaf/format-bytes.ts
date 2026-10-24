import { getByteUnitString } from '$lib/utils/byte-units';

/** A size in bytes as people read it ("1.4 GB"), in the given locale. */
export const formatBytes = (value: number, locale?: string) => getByteUnitString(value, locale);
