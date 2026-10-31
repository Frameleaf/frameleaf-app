/**
 * Frameleaf shows sizes in decimal units only (owner decision D5, 2026-10-16): 1 KB is 1,000
 * bytes, 1 MB is 1,000,000 bytes, and there is never a "KiB".
 */
export declare enum ByteUnit {
    B = "B",
    KB = "KB",
    MB = "MB",
    GB = "GB",
    TB = "TB",
    PB = "PB",
    EB = "EB"
}
/**
 * Convert bytes to best human readable unit and number of that unit.
 *
 * A value under 10 keeps up to `maxPrecision` decimals and a larger one is a whole number.
 *
 * * For `1000` bytes, returns `1` and `KB`.
 * * For `1500` bytes, returns `1.5` and `KB`.
 * * For `696_600` bytes, returns `697` and `KB`.
 *
 * @param bytes number of bytes
 * @param maxPrecision maximum number of decimal places under 10, default is `1`
 * @returns size (number) and unit (string)
 */
export declare function getBytesWithUnit(bytes: number, maxPrecision?: number): [number, ByteUnit];
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
export declare function getByteUnitString(bytes: number, locale?: string, maxPrecision?: number, separator?: string): string;
/**
 * Convert to bytes from on a specified unit.
 *
 * * `1, 'GB'`, returns `1000000000` bytes
 *
 * @param size value to be converted
 * @param unit unit to convert from
 * @returns bytes (number)
 */
export declare function convertToBytes(size: number, unit: ByteUnit): number;
/**
 * Convert from bytes to a specified unit.
 *
 * * `1000000000, 'GB'`, returns `1` GB
 *
 * @param bytes value to be converted
 * @param unit unit to convert to
 * @returns bytes (number)
 */
export declare function convertFromBytes(bytes: number, unit: ByteUnit): number;
