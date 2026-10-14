export const ByteUnit = {
  B: 'B',
  KiB: 'KiB',
  MiB: 'MiB',
  GiB: 'GiB',
  TiB: 'TiB',
  PiB: 'PiB',
  EiB: 'EiB',
};
const byteUnits = Object.values(ByteUnit);
const unitScales = byteUnits.map((_, magnitude) => 1024 ** magnitude);
const scaleByUnit = new Map(
  byteUnits.map((unit, magnitude) => [unit, unitScales[magnitude]]),
);
const logUnitBase = Math.log(1024);
const unknownUnitScale = 1 / 1024;
/**
 * Convert bytes to best human readable unit and number of that unit.
 *
 * * For `1024` bytes, returns `1` and `KiB`.
 * * For `1536` bytes, returns `1.5` and `KiB`.
 *
 * @param bytes number of bytes
 * @param maxPrecision maximum number of decimal places, default is `1`
 * @returns size (number) and unit (string)
 */
export function getBytesWithUnit(bytes, maxPrecision = 1) {
  const magnitude = Math.floor(Math.log(bytes === 0 ? 1 : bytes) / logUnitBase);
  const scale =
    magnitude >= 0 && magnitude < unitScales.length
      ? unitScales[magnitude]
      : 1024 ** magnitude;
  return [Number((bytes / scale).toFixed(maxPrecision)), byteUnits[magnitude]];
}
/**
 * Localized number of bytes with a unit.
 *
 * For `1536` bytes:
 * * en: `1.5 KiB`
 * * de: `1,5 KiB`
 *
 * @param bytes number of bytes
 * @param maxPrecision maximum number of decimal places, default is `1`
 * @returns localized bytes with unit as string
 */
export function getByteUnitString(
  bytes,
  locale,
  maxPrecision = 1,
  separator = ' ',
) {
  const [size, unit] = getBytesWithUnit(bytes, maxPrecision);
  return `${size.toLocaleString(locale)}${separator}${unit}`;
}
/**
 * Convert to bytes from on a specified unit.
 *
 * * `1, 'GiB'`, returns `1073741824` bytes
 *
 * @param size value to be converted
 * @param unit unit to convert from
 * @returns bytes (number)
 */
export function convertToBytes(size, unit) {
  return size * (scaleByUnit.get(unit) ?? unknownUnitScale);
}
/**
 * Convert from bytes to a specified unit.
 *
 * * `11073741824, 'GiB'`, returns `1` GiB
 *
 * @param bytes value to be converted
 * @param unit unit to convert to
 * @returns bytes (number)
 */
export function convertFromBytes(bytes, unit) {
  return bytes / (scaleByUnit.get(unit) ?? unknownUnitScale);
}
