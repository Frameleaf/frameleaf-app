export var ByteUnit;
(function (ByteUnit) {
    ByteUnit["B"] = "B";
    ByteUnit["KiB"] = "KiB";
    ByteUnit["MiB"] = "MiB";
    ByteUnit["GiB"] = "GiB";
    ByteUnit["TiB"] = "TiB";
    ByteUnit["PiB"] = "PiB";
    ByteUnit["EiB"] = "EiB";
})(ByteUnit || (ByteUnit = {}));
const byteUnits = [ByteUnit.B, ByteUnit.KiB, ByteUnit.MiB, ByteUnit.GiB, ByteUnit.TiB, ByteUnit.PiB, ByteUnit.EiB];
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
    const magnitude = Math.floor(Math.log(bytes === 0 ? 1 : bytes) / Math.log(1024));
    return [Number((bytes / 1024 ** magnitude).toFixed(maxPrecision)), byteUnits[magnitude]];
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
export function getByteUnitString(bytes, locale, maxPrecision = 1, separator = ' ') {
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
    return size * 1024 ** byteUnits.indexOf(unit);
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
    return bytes / 1024 ** byteUnits.indexOf(unit);
}
