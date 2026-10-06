export declare const enum ByteUnit {
    B = "B",
    KiB = "KiB",
    MiB = "MiB",
    GiB = "GiB",
    TiB = "TiB",
    PiB = "PiB",
    EiB = "EiB"
}
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
export declare function getBytesWithUnit(bytes: number, maxPrecision?: number): [number, ByteUnit];
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
export declare function getByteUnitString(bytes: number, locale?: string, maxPrecision?: number, separator?: string): string;
/**
 * Convert to bytes from on a specified unit.
 *
 * * `1, 'GiB'`, returns `1073741824` bytes
 *
 * @param size value to be converted
 * @param unit unit to convert from
 * @returns bytes (number)
 */
export declare function convertToBytes(size: number, unit: ByteUnit): number;
/**
 * Convert from bytes to a specified unit.
 *
 * * `11073741824, 'GiB'`, returns `1` GiB
 *
 * @param bytes value to be converted
 * @param unit unit to convert to
 * @returns bytes (number)
 */
export declare function convertFromBytes(bytes: number, unit: ByteUnit): number;
