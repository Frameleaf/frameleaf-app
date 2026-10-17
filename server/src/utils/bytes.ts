const KiB = Math.pow(1024, 1);
const MiB = Math.pow(1024, 2);
const GiB = Math.pow(1024, 3);
const TiB = Math.pow(1024, 4);
const PiB = Math.pow(1024, 5);

export const HumanReadableSize = { KiB, MiB, GiB, TiB, PiB };

/** D5: the GB a person types or reads (1 GB = 1,000,000,000 bytes), for quotas and download sizes. */
export const DecimalSize = { KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4 };

// D5 (owner, 2026-10-16): sizes people read are always decimal (KB, MB, GB), never KiB
const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

export function asHumanReadable(bytes: number, precision = 1): string {
  let magnitude = 0;
  let remainder = bytes;
  while (remainder >= 1000) {
    if (magnitude + 1 < units.length) {
      magnitude++;
      remainder /= 1000;
    } else {
      break;
    }
  }

  return `${remainder.toFixed(magnitude === 0 ? 0 : precision)} ${units[magnitude]}`;
}

// if an asset is jsonified in the DB before being returned, its buffer fields will be hex-encoded strings
export const hexOrBufferToBase64 = (encoded: string | Buffer) => {
  if (typeof encoded === 'string') {
    return Buffer.from(encoded.slice(2), 'hex').toString('base64');
  }

  return encoded.toString('base64');
};
