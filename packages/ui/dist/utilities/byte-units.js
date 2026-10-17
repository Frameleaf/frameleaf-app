/**
 * Frameleaf shows sizes in decimal units only (owner decision D5, 2026-10-16): 1 KB is 1,000
 * bytes, 1 MB is 1,000,000 bytes, and there is never a "KiB". These are the units people see on
 * their phone, their computer and the drive's box.
 */
export const ByteUnit = {
  B: 'B',
  KB: 'KB',
  MB: 'MB',
  GB: 'GB',
  TB: 'TB',
  PB: 'PB',
  EB: 'EB',
};
const byteUnits = Object.values(ByteUnit);
const unitBase = 1000;
const unitScales = byteUnits.map((_, magnitude) => unitBase ** magnitude);
const scaleByUnit = new Map(
  byteUnits.map((unit, magnitude) => [unit, unitScales[magnitude]]),
);
const logUnitBase = Math.log(unitBase);
const unknownUnitScale = 1 / unitBase;
/**
 * Convert bytes to best human readable unit and number of that unit.
 *
 * As in the prototype's `formatBytes`, a value under 10 keeps up to `maxPrecision` decimals and a
 * larger one is a whole number, so a size reads "1.5 KB", "62 MB" or "697 KB".
 *
 * * For `1000` bytes, returns `1` and `KB`.
 * * For `1500` bytes, returns `1.5` and `KB`.
 * * For `696_600` bytes, returns `697` and `KB`.
 *
 * @param bytes number of bytes
 * @param maxPrecision maximum number of decimal places under 10, default is `1`
 * @returns size (number) and unit (string)
 */
export function getBytesWithUnit(bytes, maxPrecision = 1) {
  let magnitude = Math.max(
    0,
    Math.floor(Math.log(bytes <= 0 ? 1 : bytes) / logUnitBase),
  );
  const scaled = (value) =>
    magnitude > 0 && value < 10
      ? Number(value.toFixed(maxPrecision))
      : Math.round(value);
  let size = scaled(bytes / unitBase ** magnitude);
  // 999,999 bytes rounds to "1000 KB"; it reads as 1 MB.
  if (size >= unitBase && magnitude < byteUnits.length - 1) {
    magnitude += 1;
    size = scaled(bytes / unitBase ** magnitude);
  }
  return [size, byteUnits[magnitude]];
}
/**
 * Localized number of bytes with a unit.
 *
 * For `1500` bytes:
 * * en: `1.5 KB`
 * * de: `1,5 KB`
 *
 * @param bytes number of bytes
 * @param maxPrecision maximum number of decimal places under 10, default is `1`
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
 * * `1, 'GB'`, returns `1000000000` bytes
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
 * * `1000000000, 'GB'`, returns `1` GB
 *
 * @param bytes value to be converted
 * @param unit unit to convert to
 * @returns bytes (number)
 */
export function convertFromBytes(bytes, unit) {
  return bytes / (scaleByUnit.get(unit) ?? unknownUnitScale);
}
