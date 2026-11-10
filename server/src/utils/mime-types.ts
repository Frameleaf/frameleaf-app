import { AssetType } from 'src/enum.js';
import { getFilenameExtension } from 'src/utils/file.js';

const raw = {
  '.3fr': ['image/3fr', 'image/x-hasselblad-3fr'],
  '.ari': ['image/ari', 'image/x-arriflex-ari'],
  '.arw': ['image/arw', 'image/x-sony-arw'],
  '.cap': ['image/cap', 'image/x-phaseone-cap'],
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
  '.psd': ['image/psd', 'image/vnd.adobe.photoshop'],
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
  '.jfi': ['image/jpeg'],
  '.jfif': ['image/jpeg'],
  '.jif': ['image/jpeg'],
  '.jpe': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.jpg': ['image/jpeg'],
  '.pjp': ['image/jpeg'],
  '.pjpeg': ['image/jpeg'],
  '.png': ['image/png', 'image/apng'],
  '.webp': ['image/webp'],
};

// FL-1356: every extension below `...raw` has a fixture in server/test/fixtures/formats/manifest.json that
// decodes in the built image. Add one only together with its fixture.
const webUnsupportedImage = {
  ...raw,
  '.btf': ['image/tiff'],
  // Kodak Cineon film scans. Not sensor data: FL-1356 moved it out of the RAW list.
  '.cin': ['image/cin', 'image/cineon'],
  '.cur': ['image/vnd.microsoft.icon'],
  '.dds': ['image/vnd-ms.dds'],
  '.dpx': ['image/dpx'],
  '.exr': ['image/x-exr'],
  '.fits': ['image/fits'],
  '.hdp': ['image/vnd.ms-photo'],
  '.hdr': ['image/vnd.radiance'],
  '.heic': ['image/heic'],
  '.heics': ['image/heic-sequence'],
  '.heif': ['image/heif'],
  '.hif': ['image/hif'],
  '.ico': ['image/vnd.microsoft.icon', 'image/x-icon'],
  '.insp': ['image/jpeg'],
  '.j2c': ['image/j2c'],
  '.j2k': ['image/j2c'],
  '.jp2': ['image/jp2'],
  '.jpc': ['image/j2c'],
  '.jpf': ['image/jpx'],
  // a stereo pair, side by side in one JPEG
  '.jps': ['image/jpeg'],
  '.jpx': ['image/jpx'],
  '.jxl': ['image/jxl'],
  '.jxr': ['image/jxr', 'image/vnd.ms-photo'],
  '.mpo': ['image/jpeg'],
  '.pam': ['image/x-portable-arbitrarymap'],
  '.pbm': ['image/x-portable-bitmap'],
  '.pct': ['image/x-pict'],
  '.pcx': ['image/vnd.zbrush.pcx', 'image/x-pcx'],
  '.pfm': ['image/x-portable-floatmap'],
  '.pgm': ['image/x-portable-graymap'],
  '.pict': ['image/x-pict'],
  '.pnm': ['image/x-portable-anymap'],
  '.ppm': ['image/x-portable-pixmap'],
  '.qoi': ['image/qoi'],
  '.sgi': ['image/sgi'],
  '.svg': ['image/svg'],
  '.svgz': ['image/svg'],
  '.tga': ['image/x-tga', 'image/x-targa'],
  '.tif': ['image/tiff'],
  '.tiff': ['image/tiff'],
  '.wdp': ['image/vnd.ms-photo'],
  '.xcf': ['image/x-xcf'],
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

/**
 * FL-1357: cinema camera RAW. No open decoder exists for these (owner 2026-11-10: no closed SDKs), so they are
 * kept safe as videos (stored, checksummed, searchable, downloadable) and are never promised to play.
 * ARRIRAW `.ari` frames stay with the RAW photos above, where LibRaw opens them.
 */
const cinemaRaw = new Set(['.arx', '.braw', '.crm', '.nev', '.r3d']);

// DJI `.lrf` and GoPro `.lrv` preview files are left out on purpose (FL-968): they duplicate the real recording.
const video: Record<string, string[]> = {
  // FL-968: GoPro MAX 360° recordings (two cubemap tracks in an MP4 container)
  '.360': ['video/mp4'],
  '.3g2': ['video/3gpp2'],
  '.3gp': ['video/3gpp'],
  '.3gpp': ['video/3gpp'],
  '.apv': ['video/x-apv'],
  '.arx': ['video/x-arri-arx'],
  '.asf': ['video/x-ms-asf'],
  '.avi': ['video/avi', 'video/msvideo', 'video/vnd.avi', 'video/x-msvideo'],
  '.braw': ['video/x-braw'],
  '.cine': ['video/x-phantom-cine'],
  '.crm': ['video/x-canon-crm'],
  '.dif': ['video/x-dv', 'video/dv'],
  '.divx': ['video/divx'],
  '.dv': ['video/x-dv', 'video/dv'],
  '.dvr-ms': ['video/x-ms-dvr'],
  '.evo': ['video/mpeg'],
  '.f4v': ['video/x-f4v', 'video/mp4'],
  '.flv': ['video/x-flv'],
  '.gxf': ['video/x-gxf'],
  '.h264': ['video/h264'],
  '.h265': ['video/h265'],
  '.hevc': ['video/h265'],
  '.insv': ['video/mp4'],
  '.ivf': ['video/x-ivf'],
  '.m1v': ['video/mpeg'],
  '.m2p': ['video/mp2p'],
  '.m2t': ['video/mp2t'],
  '.m2ts': ['video/mp2t'],
  '.m2v': ['video/mpeg'],
  '.m4v': ['video/x-m4v'],
  '.mj2': ['video/mj2'],
  '.mjpeg': ['video/x-motion-jpeg'],
  '.mjpg': ['video/x-motion-jpeg'],
  '.mk3d': ['video/x-matroska'],
  '.mkv': ['video/x-matroska'],
  '.mlv': ['video/x-magic-lantern'],
  '.mod': ['video/mpeg'],
  '.mov': ['video/quicktime'],
  '.mp4': ['video/mp4'],
  '.mpe': ['video/mpeg'],
  '.mpeg': ['video/mpeg'],
  '.mpg': ['video/mpeg'],
  '.mts': ['video/mp2t'],
  '.mxf': ['application/mxf'],
  '.nev': ['video/x-nikon-nev'],
  '.nut': ['video/x-nut'],
  '.ogm': ['video/ogg'],
  '.ogv': ['video/ogg'],
  // FL-968: DJI Osmo 360 recordings (dual fisheye in an MP4 container)
  '.osv': ['video/mp4'],
  '.qt': ['video/quicktime'],
  '.r3d': ['video/x-red-r3d'],
  '.rm': ['video/vnd.rn-realvideo'],
  '.rmvb': ['video/vnd.rn-realvideo'],
  '.tod': ['video/mp2t'],
  '.tp': ['video/mp2t'],
  '.trp': ['video/mp2t'],
  '.ts': ['video/mp2t'],
  '.vc1': ['video/vc1'],
  '.vob': ['video/mpeg'],
  '.vro': ['video/mpeg'],
  '.webm': ['video/webm'],
  '.wmv': ['video/x-ms-wmv'],
  '.wtv': ['video/x-ms-wtv'],
  '.y4m': ['video/x-yuv4mpeg'],
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
  isCinemaRaw: (filename: string) => cinemaRaw.has(getFilenameExtension(filename).toLowerCase()),
  isHeic: (filename: string) => heicExtensions.has(getFilenameExtension(filename).toLowerCase()),
  lookup,
  assetType: (filename: string) => {
    const contentType = lookup(filename);
    if (contentType.startsWith('image/')) {
      return AssetType.Image;
    }

    if (contentType === 'application/mxf' || contentType.startsWith('video/')) {
      return AssetType.Video;
    }

    return AssetType.Other;
  },
  getSupportedFileExtensions: () => [...Object.keys(image), ...Object.keys(video)],
};
