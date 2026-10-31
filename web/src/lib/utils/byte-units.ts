import { getByteUnitString as formatByteUnitString } from '@frameleaf/ui/byte-units';

export { ByteUnit, convertFromBytes, convertToBytes, getBytesWithUnit } from '@frameleaf/ui/byte-units';

export function getByteUnitString(bytes: number, locale?: string, maxPrecision = 1): string {
  return formatByteUnitString(bytes, locale, maxPrecision);
}
