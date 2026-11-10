import { AssetType } from 'src/enum.js';
import { getFilenameExtension } from 'src/utils/file.js';

const raw = {
  '.3fr': ['image/3fr', 'image/x-hasselblad-3fr'],
  '.ari': ['image/ari', 'image/x-arriflex-ari'],
  '.arw': ['image/arw', 'image/x-sony-arw'],
  '.cap': ['image/cap', 'image/x-phaseone-cap'],
  '.cin': ['image/cin', 'image/x-phantom-cin'],
  '.cr2': ['image/cr2', 'image/x-canon-cr2'],
  '.cr3': ['image/cr3', 'image/x-canon-cr3'],
  '.crw': ['image/crw', 'image/x-canon-crw'],
  '.dcr': ['image/dcr', 'image/x-kodak-dcr'],
  '.dng': ['image/dng', 'image/x-adobe-dng'],
  '.erf': ['image/erf', 'image/x-epson-erf'],
  '.fff': ['image/fff', 'image/x-hasselblad-fff'],
  '.iiq': ['image/iiq', 'image/x-phaseone-iiq'],
  '.k25': ['image/k25', 'image/x-kodak-k25'],
  '.kdc': ['image/kdc', 'image/x-kodak-kdc'],
  '.mef': ['image/mef', 'image/x-mamiya-mef'],
  '.mos': ['image/mos', 'image/x-leaf-mos'],
  '.mrw': ['image/mrw', 'image/x-minolta-mrw'],
  '.nef': ['image/nef', 'image/x-nikon-nef'],
  '.nrw': ['image/nrw', 'image/x-nikon-nrw'],
  '.orf': ['image/orf', 'image/x-olympus-orf'],
  '.ori': ['image/ori', 'image/x-olympus-ori'],
  '.pef': ['image/pef', 'image/x-pentax-pef'],
  '.raf': ['image/raf', 'image/x-fuji-raf'],
  '.raw': ['image/raw', 'image/x-panasonic-raw'],
  '.rw2': ['image/rw2', 'image/x-panasonic-rw2'],
  '.rwl': ['image/rwl', 'image/x-leica-rwl'],
  '.sr2': ['image/sr2', 'image/x-sony-sr2'],
  '.srf': ['image/srf', 'image/x-sony-srf'],
  '.srw': ['image/srw', 'image/x-samsung-srw'],
  '.x3f': ['image/x3f', 'image/x-sigma-x3f'],
};

/**
 * Design files (FL-1358): kept whole, shown by a rendering or by the preview the file carries, and never
 * decoded as sensor data. An extension is listed only with a fixture in `test/fixtures/formats/design`.
 */
const design: Record<string, string[]> = {
  '.ai': ['application/illustrator', 'application/postscript', 'application/pdf'],
  '.cdr': ['application/vnd.corel-draw', 'application/x-cdr'],
  '.eps': ['application/postscript', 'application/eps', 'image/x-eps'],
  '.fig': ['application/x-figma'],
  '.kra': ['application/x-krita'],
  '.ora': ['image/openraster'],
  '.pdf': ['application/pdf'],
  '.procreate': ['application/x-procreate'],
  '.psb': ['image/vnd.adobe.photoshop', 'application/x-photoshop'],
  '.psd': ['image/psd', 'image/vnd.adobe.photoshop'],
  '.sketch': ['application/x-sketch', 'application/zip'],
  '.xcf': ['image/x-xcf'],
  '.xd': ['application/vnd.adobe.xd', 'application/zip'],
};

/**
 * list of supported image extensions from https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Image_types excluding svg,
 * plus `.avifs` (an AVIF image sequence, served as `image/avif`)
 * @TODO share with the client
 * @see {@link web/src/lib/utils/asset-utils.ts#L329}
 **/
const webSupportedImage = {
  '.apng': ['image/apng'],
  '.avif': ['image/avif'],
  '.avifs': ['image/avif'],
  '.bmp': ['image/bmp'],
  '.gif': ['image/gif'],
  '.jfif': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.jpg': ['image/jpeg'],
  '.pjp': ['image/jpeg'],
  '.pjpeg': ['image/jpeg'],
  '.png': ['image/png', 'image/apng'],
  '.webp': ['image/webp'],
};

const webUnsupportedImage = {
  ...raw,
  ...design,
  '.hdr': ['image/vnd.radiance'],
  '.heic': ['image/heic'],
  '.heics': ['image/heic-sequence'],
  '.heif': ['image/heif'],
  '.hif': ['image/hif'],
  '.insp': ['image/jpeg'],
  '.jp2': ['image/jp2'],
  '.jpe': ['image/jpeg'],
  '.jxl': ['image/jxl'],
  '.mpo': ['image/jpeg'],
  '.pbm': ['image/x-portable-bitmap'],
  '.pfm': ['image/x-portable-floatmap'],
  '.pgm': ['image/x-portable-graymap'],
  '.pnm': ['image/x-portable-anymap'],
  '.ppm': ['image/x-portable-pixmap'],
  '.svg': ['image/svg'],
  '.tif': ['image/tiff'],
  '.tiff': ['image/tiff'],
};

const image: Record<string, string[]> = {
  ...webSupportedImage,
  ...webUnsupportedImage,
};

const possiblyAnimatedImageExtensions = new Set([
  '.apng',
  '.avif',
  '.avifs',
  '.gif',
  '.heic',
  '.heics',
  '.heif',
  '.jxl',
  '.png',
  '.webp',
]);

const heifImageExtensions = new Set(['.avif', '.avifs', '.heic', '.heics', '.heif', '.hif']);

const transparentCapableExtensions = new Set([
  '.apng',
  '.avif',
  '.avifs',
  '.bmp',
  '.gif',
  '.heic',
  '.heics',
  '.heif',
  '.hif',
  '.jxl',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);

const heicExtensions = new Set(['.heic', '.heics', '.heif', '.hif']);

const profileExtensions = new Set(['.avif', '.dng', '.heic', '.heif', '.jpeg', '.jpg', '.png', '.webp', '.svg']);
const profile: Record<string, string[]> = Object.fromEntries(
  Object.entries(image).filter(([key]) => profileExtensions.has(key)),
);

const video: Record<string, string[]> = {
  // FL-968: GoPro MAX 360° recordings (two cubemap tracks in an MP4 container)
  '.360': ['video/mp4'],
  '.3g2': ['video/3gpp2'],
  '.3gp': ['video/3gpp'],
  '.3gpp': ['video/3gpp'],
  '.asf': ['video/x-ms-asf'],
  '.avi': ['video/avi', 'video/msvideo', 'video/vnd.avi', 'video/x-msvideo'],
  '.divx': ['video/divx'],
  '.dv': ['video/x-dv', 'video/dv'],
  '.f4v': ['video/x-f4v', 'video/mp4'],
  '.flv': ['video/x-flv'],
  '.insv': ['video/mp4'],
  '.m2t': ['video/mp2t'],
  '.m2ts': ['video/mp2t'],
  '.m4v': ['video/x-m4v'],
  '.mk3d': ['video/x-matroska'],
  '.mkv': ['video/x-matroska'],
  '.mod': ['video/mpeg'],
  '.mov': ['video/quicktime'],
  '.mp4': ['video/mp4'],
  '.mpe': ['video/mpeg'],
  '.mpeg': ['video/mpeg'],
  '.mpg': ['video/mpeg'],
  '.mts': ['video/mp2t'],
  '.mxf': ['application/mxf'],
  '.ogv': ['video/ogg'],
  // FL-968: DJI Osmo 360 recordings (dual fisheye in an MP4 container)
  '.osv': ['video/mp4'],
  '.qt': ['video/quicktime'],
  '.rm': ['video/vnd.rn-realvideo'],
  '.rmvb': ['video/vnd.rn-realvideo'],
  '.tod': ['video/mp2t'],
  '.ts': ['video/mp2t'],
  '.vob': ['video/mpeg'],
  '.vro': ['video/mpeg'],
  '.webm': ['video/webm'],
  '.wmv': ['video/x-ms-wmv'],
};

const sidecar: Record<string, string[]> = {
  '.xmp': ['application/xml', 'text/xml'],
};

const types = { ...image, ...video, ...sidecar };

const isType = (filename: string, r: Record<string, string[]>) =>
  Object.hasOwn(r, getFilenameExtension(filename).toLowerCase());

const lookup = (filename: string) =>
  types[getFilenameExtension(filename).toLowerCase()]?.[0] ?? 'application/octet-stream';

export const mimeTypes = {
  image,
  profile,
  sidecar,
  video,
  raw,
  design,
  webUnsupportedImage,

  isAsset: (filename: string) => {
    const extension = getFilenameExtension(filename).toLowerCase();
    return Object.hasOwn(image, extension) || Object.hasOwn(video, extension);
  },
  isImage: (filename: string) => isType(filename, image),
  isWebSupportedImage: (filename: string) => isType(filename, webSupportedImage),
  isHeifImage: (filename: string) => heifImageExtensions.has(getFilenameExtension(filename).toLowerCase()),
  isPossiblyAnimatedImage: (filename: string) =>
    possiblyAnimatedImageExtensions.has(getFilenameExtension(filename).toLowerCase()),
  isProfile: (filename: string) => isType(filename, profile),
  isSidecar: (filename: string) => isType(filename, sidecar),
  isVideo: (filename: string) => isType(filename, video),
  canBeTransparent: (filename: string) =>
    transparentCapableExtensions.has(getFilenameExtension(filename).toLowerCase()),
  isRaw: (filename: string) => isType(filename, raw),
  isDesign: (filename: string) => isType(filename, design),
  isHeic: (filename: string) => heicExtensions.has(getFilenameExtension(filename).toLowerCase()),
  lookup,
  assetType: (filename: string) => {
    const contentType = lookup(filename);
    // A design file is an image whatever its own type says (a PDF is "application/pdf").
    if (contentType.startsWith('image/') || isType(filename, design)) {
      return AssetType.Image;
    }

    if (contentType === 'application/mxf' || contentType.startsWith('video/')) {
      return AssetType.Video;
    }

    return AssetType.Other;
  },
  // ponytail: folders Frameleaf watches or walks keep to photos and videos (and .psd, as before), so an
  // upgrade does not pull every PDF beside the photos into the library. Design files arrive by upload or import.
  getSupportedFileExtensions: () => [
    ...Object.keys(image).filter((extension) => extension === '.psd' || !Object.hasOwn(design, extension)),
    ...Object.keys(video),
  ],
};
