import { AssetType } from 'src/enum.js';
import { mimeTypes } from 'src/utils/mime-types.js';

// Offered before the format matrix existed (FL-1354); new extensions need a fixture.
const LEGACY_STILLS = new Set(
  '.hdr .heic .heics .heif .hif .insp .jxl .mpo .pbm .pfm .pgm .pnm .ppm .svg .tiff'.split(' '),
);

describe('mimeTypes', () => {
  it('classifies supported extensions consistently across filename forms', () => {
    const animated = new Set(['.apng', '.avif', '.avifs', '.gif', '.heic', '.heics', '.heif', '.jxl', '.png', '.webp']);
    const heif = new Set(['.avif', '.avifs', '.heic', '.heics', '.heif', '.hif']);
    for (const extension of [...mimeTypes.getSupportedFileExtensions(), '.xmp', '.unknown']) {
      for (const filename of [extension, `photo${extension.toUpperCase()}`, `/media.with.dots/photo${extension}`]) {
        expect(mimeTypes.isAsset(filename)).toBe(
          Object.hasOwn(mimeTypes.image, extension) || Object.hasOwn(mimeTypes.video, extension),
        );
        expect(mimeTypes.isPossiblyAnimatedImage(filename)).toBe(animated.has(extension));
        expect(mimeTypes.isHeifImage(filename)).toBe(heif.has(extension));
      }
    }
    for (const filename of ['', 'photo', 'photo.', '/media.jpg/photo', '/media.jpg/.hidden']) {
      expect(mimeTypes.isAsset(filename)).toBe(false);
      expect(mimeTypes.isPossiblyAnimatedImage(filename)).toBe(false);
      expect(mimeTypes.isHeifImage(filename)).toBe(false);
    }
  });

  it('keeps asset checks live while metadata categories remain fixed', () => {
    mimeTypes.image['.frameleaf-test-image'] = ['image/frameleaf-test'];
    mimeTypes.video['.frameleaf-test-video'] = ['video/frameleaf-test'];
    try {
      expect(mimeTypes.isAsset('photo.FRAMELEAF-TEST-IMAGE')).toBe(true);
      expect(mimeTypes.isAsset('movie.FRAMELEAF-TEST-VIDEO')).toBe(true);
      expect(mimeTypes.isPossiblyAnimatedImage('photo.frameleaf-test-image')).toBe(false);
      expect(mimeTypes.isHeifImage('photo.frameleaf-test-image')).toBe(false);
    } finally {
      delete mimeTypes.image['.frameleaf-test-image'];
      delete mimeTypes.video['.frameleaf-test-video'];
    }
  });

  for (const { mimetype, extension } of [
    // Please ensure this list is sorted.
    { mimetype: 'image/3fr', extension: '.3fr' },
    { mimetype: 'image/ari', extension: '.ari' },
    { mimetype: 'image/apng', extension: '.apng' },
    { mimetype: 'image/arw', extension: '.arw' },
    { mimetype: 'image/avif', extension: '.avif' },
    { mimetype: 'image/avif', extension: '.avifs' },
    { mimetype: 'image/bmp', extension: '.bmp' },
    { mimetype: 'image/cap', extension: '.cap' },
    { mimetype: 'image/cin', extension: '.cin' },
    { mimetype: 'image/cr2', extension: '.cr2' },
    { mimetype: 'image/cr3', extension: '.cr3' },
    { mimetype: 'image/crw', extension: '.crw' },
    { mimetype: 'image/dcr', extension: '.dcr' },
    { mimetype: 'image/dng', extension: '.dng' },
    { mimetype: 'image/erf', extension: '.erf' },
    { mimetype: 'image/fff', extension: '.fff' },
    { mimetype: 'image/gif', extension: '.gif' },
    { mimetype: 'image/gpr', extension: '.gpr' },
    { mimetype: 'image/heic', extension: '.heic' },
    { mimetype: 'image/heic-sequence', extension: '.heics' },
    { mimetype: 'image/heif', extension: '.heif' },
    { mimetype: 'image/hif', extension: '.hif' },
    { mimetype: 'image/iiq', extension: '.iiq' },
    { mimetype: 'image/jp2', extension: '.jp2' },
    { mimetype: 'image/jpeg', extension: '.jpe' },
    { mimetype: 'image/jpeg', extension: '.jpeg' },
    { mimetype: 'image/jpeg', extension: '.jfif' },
    { mimetype: 'image/jpeg', extension: '.jpg' },
    { mimetype: 'image/jpeg', extension: '.mpo' },
    { mimetype: 'image/jpeg', extension: '.pjp' },
    { mimetype: 'image/jpeg', extension: '.pjpeg' },
    { mimetype: 'image/jxl', extension: '.jxl' },
    { mimetype: 'image/k25', extension: '.k25' },
    { mimetype: 'image/kdc', extension: '.kdc' },
    { mimetype: 'image/mef', extension: '.mef' },
    { mimetype: 'image/mos', extension: '.mos' },
    { mimetype: 'image/mrw', extension: '.mrw' },
    { mimetype: 'image/nef', extension: '.nef' },
    { mimetype: 'image/nrw', extension: '.nrw' },
    { mimetype: 'image/orf', extension: '.orf' },
    { mimetype: 'image/ori', extension: '.ori' },
    { mimetype: 'image/pef', extension: '.pef' },
    { mimetype: 'image/png', extension: '.png' },
    { mimetype: 'image/psd', extension: '.psd' },
    { mimetype: 'image/raf', extension: '.raf' },
    { mimetype: 'image/raw', extension: '.raw' },
    { mimetype: 'image/rwl', extension: '.rwl' },
    { mimetype: 'image/sr2', extension: '.sr2' },
    { mimetype: 'image/srf', extension: '.srf' },
    { mimetype: 'image/srw', extension: '.srw' },
    { mimetype: 'image/svg', extension: '.svg' },
    { mimetype: 'image/tiff', extension: '.tif' },
    { mimetype: 'image/tiff', extension: '.tiff' },
    { mimetype: 'image/vnd.radiance', extension: '.hdr' },
    { mimetype: 'image/webp', extension: '.webp' },
    { mimetype: 'image/vnd.adobe.photoshop', extension: '.psd' },
    { mimetype: 'image/x-adobe-dng', extension: '.dng' },
    { mimetype: 'image/x-arriflex-ari', extension: '.ari' },
    { mimetype: 'image/x-canon-cr2', extension: '.cr2' },
    { mimetype: 'image/x-canon-cr3', extension: '.cr3' },
    { mimetype: 'image/x-canon-crw', extension: '.crw' },
    { mimetype: 'image/x-epson-erf', extension: '.erf' },
    { mimetype: 'image/x-fuji-raf', extension: '.raf' },
    { mimetype: 'image/x-gopro-gpr', extension: '.gpr' },
    { mimetype: 'image/x-hasselblad-3fr', extension: '.3fr' },
    { mimetype: 'image/x-hasselblad-fff', extension: '.fff' },
    { mimetype: 'image/x-kodak-dcr', extension: '.dcr' },
    { mimetype: 'image/x-kodak-k25', extension: '.k25' },
    { mimetype: 'image/x-kodak-kdc', extension: '.kdc' },
    { mimetype: 'image/x-leaf-mos', extension: '.mos' },
    { mimetype: 'image/x-leica-rwl', extension: '.rwl' },
    { mimetype: 'image/x-mamiya-mef', extension: '.mef' },
    { mimetype: 'image/x-minolta-mrw', extension: '.mrw' },
    { mimetype: 'image/x-nikon-nef', extension: '.nef' },
    { mimetype: 'image/x-olympus-orf', extension: '.orf' },
    { mimetype: 'image/x-olympus-ori', extension: '.ori' },
    { mimetype: 'image/x-panasonic-raw', extension: '.raw' },
    { mimetype: 'image/x-pentax-pef', extension: '.pef' },
    { mimetype: 'image/x-phaseone-cap', extension: '.cap' },
    { mimetype: 'image/x-phaseone-iiq', extension: '.iiq' },
    { mimetype: 'image/x-portable-anymap', extension: '.pnm' },
    { mimetype: 'image/x-portable-bitmap', extension: '.pbm' },
    { mimetype: 'image/x-portable-floatmap', extension: '.pfm' },
    { mimetype: 'image/x-portable-graymap', extension: '.pgm' },
    { mimetype: 'image/x-portable-pixmap', extension: '.ppm' },
    { mimetype: 'image/x-samsung-srw', extension: '.srw' },
    { mimetype: 'image/x-sigma-x3f', extension: '.x3f' },
    { mimetype: 'image/x-sony-arw', extension: '.arw' },
    { mimetype: 'image/x-sony-sr2', extension: '.sr2' },
    { mimetype: 'image/x-sony-srf', extension: '.srf' },
    { mimetype: 'image/x3f', extension: '.x3f' },
    { mimetype: 'application/mxf', extension: '.mxf' },
    { mimetype: 'video/3gpp', extension: '.3gp' },
    { mimetype: 'video/3gpp', extension: '.3gpp' },
    { mimetype: 'video/3gpp2', extension: '.3g2' },
    { mimetype: 'video/avi', extension: '.avi' },
    { mimetype: 'video/divx', extension: '.divx' },
    { mimetype: 'video/dv', extension: '.dv' },
    { mimetype: 'video/mp2t', extension: '.m2t' },
    { mimetype: 'video/mp2t', extension: '.m2ts' },
    { mimetype: 'video/mp2t', extension: '.mts' },
    { mimetype: 'video/mp2t', extension: '.tod' },
    { mimetype: 'video/mp2t', extension: '.ts' },
    { mimetype: 'video/mp4', extension: '.360' },
    { mimetype: 'video/mp4', extension: '.f4v' },
    { mimetype: 'video/mp4', extension: '.insv' },
    { mimetype: 'video/mp4', extension: '.mp4' },
    { mimetype: 'video/mp4', extension: '.osv' },
    { mimetype: 'video/mpeg', extension: '.mod' },
    { mimetype: 'video/mpeg', extension: '.mpe' },
    { mimetype: 'video/mpeg', extension: '.mpeg' },
    { mimetype: 'video/mpeg', extension: '.mpg' },
    { mimetype: 'video/msvideo', extension: '.avi' },
    { mimetype: 'video/ogg', extension: '.ogv' },
    { mimetype: 'video/quicktime', extension: '.mov' },
    { mimetype: 'video/quicktime', extension: '.qt' },
    { mimetype: 'video/vnd.rn-realvideo', extension: '.rm' },
    { mimetype: 'video/vnd.rn-realvideo', extension: '.rmvb' },
    { mimetype: 'video/vnd.avi', extension: '.avi' },
    { mimetype: 'video/webm', extension: '.webm' },
    { mimetype: 'video/x-dv', extension: '.dv' },
    { mimetype: 'video/x-f4v', extension: '.f4v' },
    { mimetype: 'video/x-flv', extension: '.flv' },
    { mimetype: 'video/x-matroska', extension: '.mk3d' },
    { mimetype: 'video/x-matroska', extension: '.mkv' },
    { mimetype: 'video/x-ms-asf', extension: '.asf' },
    { mimetype: 'video/x-ms-wmv', extension: '.wmv' },
    { mimetype: 'video/x-msvideo', extension: '.avi' },
    { mimetype: 'video/mpeg', extension: '.vob' },
    { mimetype: 'video/mpeg', extension: '.vro' },
  ]) {
    it(`should map ${extension} to ${mimetype}`, () => {
      expect({ ...mimeTypes.image, ...mimeTypes.video }[extension]).toContain(mimetype);
    });
  }

  describe('profile', () => {
    it('should contain only lowercase mime types', () => {
      const keys = Object.keys(mimeTypes.profile);
      expect(keys).toEqual(keys.map((mimeType) => mimeType.toLowerCase()));

      const values = Object.values(mimeTypes.profile).flat();
      expect(values).toEqual(values.map((mimeType) => mimeType.toLowerCase()));
    });

    for (const [extension, v] of Object.entries(mimeTypes.profile)) {
      it(`should lookup ${extension}`, () => {
        expect(mimeTypes.lookup(`test.${extension}`)).toEqual(v[0]);
      });
    }
  });

  describe('image', () => {
    it('should contain only lowercase mime types', () => {
      const keys = Object.keys(mimeTypes.image);
      expect(keys).toEqual(keys.map((mimeType) => mimeType.toLowerCase()));

      const values = Object.values(mimeTypes.image).flat();
      expect(values).toEqual(values.map((mimeType) => mimeType.toLowerCase()));
    });

    it('should contain only image mime types', () => {
      const values = Object.values(mimeTypes.image).flat();
      expect(values).toEqual(values.filter((mimeType) => mimeType.startsWith('image/')));
    });

    for (const [extension, v] of Object.entries(mimeTypes.image)) {
      it(`should lookup ${extension}`, () => {
        expect(mimeTypes.lookup(`test.${extension}`)).toEqual(v[0]);
      });
    }
  });

  describe('canBeTransparent', () => {
    for (const img of [
      'a.apng',
      'a.avif',
      'a.avifs',
      'a.bmp',
      'a.gif',
      'a.heic',
      'a.heics',
      'a.heif',
      'a.hif',
      'a.jxl',
      'a.png',
      'a.svg',
      'a.tif',
      'a.tiff',
      'a.webp',
    ]) {
      it(`should return true for ${img}`, () => {
        expect(mimeTypes.canBeTransparent(img)).toBe(true);
      });
    }

    for (const img of [
      'a.jpg',
      'a.jpeg',
      'a.jpe',
      'a.jfif',
      'a.insp',
      'a.jp2',
      'a.hdr',
      'a.pfm',
      'a.cr3',
      'a.dng',
      'a.mef',
      'a.mos',
      'a.nef',
      'a.arw',
    ]) {
      it(`should return false for ${img}`, () => {
        expect(mimeTypes.canBeTransparent(img)).toBe(false);
      });
    }
  });

  describe('animated image', () => {
    for (const img of ['a.apng', 'a.avif', 'a.avifs', 'a.gif', 'a.heics', 'a.webp']) {
      it('should identify animated image mime types as such', () => {
        expect(mimeTypes.isPossiblyAnimatedImage(img)).toBeTruthy();
      });
    }

    for (const img of ['a.cr3', 'a.hdr', 'a.jfif', 'a.jpg', 'a.pbm', 'a.tiff']) {
      it('should identify static image mime types as such', () => {
        expect(mimeTypes.isPossiblyAnimatedImage(img)).toBeFalsy();
      });
    }

    for (const extension of Object.keys(mimeTypes.video)) {
      it('should not identify video mime types as animated', () => {
        expect(mimeTypes.isPossiblyAnimatedImage(extension)).toBeFalsy();
      });
    }
  });

  describe('video', () => {
    it('should contain only lowercase mime types', () => {
      const keys = Object.keys(mimeTypes.video);
      expect(keys).toEqual(keys.map((mimeType) => mimeType.toLowerCase()));

      const values = Object.values(mimeTypes.video).flat();
      expect(values).toEqual(values.map((mimeType) => mimeType.toLowerCase()));
    });

    it('should be a sorted list', () => {
      const keys = Object.keys(mimeTypes.video);
      expect(keys).toEqual(keys.toSorted());
    });

    it('should contain only video mime types', () => {
      const values = Object.values(mimeTypes.video).flat();
      expect(values).toEqual(
        values.filter((mimeType) => mimeType.startsWith('video/') || mimeType === 'application/mxf'),
      );
    });

    for (const [extension, v] of Object.entries(mimeTypes.video)) {
      it(`should lookup ${extension}`, () => {
        expect(mimeTypes.lookup(`test.${extension}`)).toEqual(v[0]);
      });
    }
  });

  describe('360° cameras (FL-968)', () => {
    for (const filename of ['VID_20250101_120000_00_001.insv', 'CAM_20250801120000_0001_D.OSV', 'GS010001.360']) {
      it(`should treat ${filename} as an MP4 video`, () => {
        expect(mimeTypes.isVideo(filename)).toBe(true);
        expect(mimeTypes.isAsset(filename)).toBe(true);
        expect(mimeTypes.lookup(filename)).toBe('video/mp4');
        expect(mimeTypes.assetType(filename)).toBe(AssetType.Video);
      });
    }

    // Proxies and telemetry the cameras write next to the real recording must never import as assets.
    for (const filename of ['DJI_0001.LRF', 'GL010001.LRV', 'GS010001.THM', 'GX010001.thm', 'DJI_0001.SRT']) {
      it(`should not import ${filename}`, () => {
        expect(mimeTypes.isAsset(filename)).toBe(false);
        expect(mimeTypes.isSidecar(filename)).toBe(false);
        expect(mimeTypes.assetType(filename)).toBe(AssetType.Other);
        expect(mimeTypes.getSupportedFileExtensions()).not.toContain(filename.slice(-4).toLowerCase());
      });
    }
  });

  describe('sidecar', () => {
    it('should contain only lowercase mime types', () => {
      const keys = Object.keys(mimeTypes.sidecar);
      expect(keys).toEqual(keys.map((mimeType) => mimeType.toLowerCase()));

      const values = Object.values(mimeTypes.sidecar).flat();
      expect(values).toEqual(values.map((mimeType) => mimeType.toLowerCase()));
    });

    it('should be a sorted list', () => {
      const keys = Object.keys(mimeTypes.sidecar);
      expect(keys).toEqual(keys.toSorted());
    });

    it('should contain only xml mime types', () => {
      expect(Object.values(mimeTypes.sidecar).flat()).toEqual(['application/xml', 'text/xml']);
    });

    for (const [extension, v] of Object.entries(mimeTypes.sidecar)) {
      it(`should lookup ${extension}`, () => {
        expect(mimeTypes.lookup(`it.${extension}`)).toEqual(v[0]);
      });
    }
  });

  describe('FL-1286 formats', () => {
    it('serves JPEG, APNG and AVIF sequence originals to the browser', () => {
      for (const filename of ['a.jfif', 'a.pjpeg', 'a.pjp', 'a.apng', 'a.avifs']) {
        expect(mimeTypes.isWebSupportedImage(filename)).toBe(true);
        expect(mimeTypes.assetType(filename)).toBe(AssetType.Image);
      }
    });

    it('shows Radiance, portable anymap and HEIF sequence photos through a preview', () => {
      for (const filename of ['a.hdr', 'a.heics', 'a.pbm', 'a.pfm', 'a.pgm', 'a.pnm', 'a.ppm']) {
        expect(mimeTypes.isImage(filename)).toBe(true);
        expect(mimeTypes.isWebSupportedImage(filename)).toBe(false);
        expect(Object.hasOwn(mimeTypes.webUnsupportedImage, filename.slice(1))).toBe(true);
        expect(mimeTypes.isRaw(filename)).toBe(false);
      }
      expect(mimeTypes.isHeic('a.heics')).toBe(true);
    });

    it('reads Mamiya and Leaf files as RAW', () => {
      for (const filename of ['a.mef', 'a.MOS']) {
        expect(mimeTypes.isRaw(filename)).toBe(true);
        expect(mimeTypes.assetType(filename)).toBe(AssetType.Image);
      }
    });

    it('imports camcorder, disc and older video containers as videos', () => {
      for (const extension of ['.3g2', '.asf', '.divx', '.dv', '.f4v', '.mk3d', '.mod', '.ogv', '.qt', '.rm']) {
        expect(mimeTypes.assetType(`clip${extension}`)).toBe(AssetType.Video);
        expect(mimeTypes.isVideo(`clip${extension.toUpperCase()}`)).toBe(true);
      }
      for (const extension of ['.rmvb', '.tod', '.vro']) {
        expect(mimeTypes.assetType(`clip${extension}`)).toBe(AssetType.Video);
      }
      expect(mimeTypes.getSupportedFileExtensions()).toEqual(
        expect.arrayContaining(['.mod', '.tod', '.heics', '.mos']),
      );
    });

    // Not decodable by the bundled libvips/ImageMagick/ExifTool/ffmpeg, so not offered (see the FL-1286 PR).
    it.each(['a.braw', 'a.r3d', 'a.crm', 'a.ogg', 'a.mjpeg', 'a.y4m'])('does not accept %s', (filename) => {
      expect(mimeTypes.isAsset(filename)).toBe(false);
      expect(mimeTypes.assetType(filename)).toBe(AssetType.Other);
    });
  });

  describe('FL-1356 still formats', () => {
    it('serves every JPEG name to the browser as it is', () => {
      for (const filename of ['a.jpe', 'a.jfi', 'a.JIF']) {
        expect(mimeTypes.isWebSupportedImage(filename)).toBe(true);
        expect(mimeTypes.lookup(filename)).toBe('image/jpeg');
      }
    });

    it('reads a Cineon scan as a picture, not as sensor data', () => {
      expect(mimeTypes.isRaw('scan.cin')).toBe(false);
      expect(mimeTypes.isImage('scan.CIN')).toBe(true);
    });

    it.each(
      '.jps .j2k .j2c .jpc .jpf .jpx .jxr .wdp .hdp .exr .tga .ico .cur .pcx .dds .dpx .cin .sgi .xcf .pict .pct .fits .qoi .pam .btf .svgz'.split(
        ' ',
      ),
    )('shows %s through a preview', (extension) => {
      expect(mimeTypes.assetType(`a${extension}`)).toBe(AssetType.Image);
      expect(mimeTypes.isWebSupportedImage(`a${extension}`)).toBe(false);
      expect(mimeTypes.isRaw(`a${extension}`)).toBe(false);
    });

    // FL-968: a camera's .thm sits beside its video and must not become a photo of its own.
    // AVC-coded HEIF needs an H.264 decoder in libheif, which the image does not have.
    it.each(['a.thm', 'a.avci', 'a.avcs'])('does not accept %s', (filename) => {
      expect(mimeTypes.isAsset(filename)).toBe(false);
    });

    it('offers no extension without a fixture that proves it', async () => {
      const { readFileSync } = await import('node:fs');
      const manifest = JSON.parse(
        readFileSync(new URL('../../test/fixtures/formats/manifest.json', import.meta.url), 'utf8'),
      ) as { fixtures: { file: string; expectedFailure?: string }[] };
      const proven = new Set(
        manifest.fixtures
          .filter((fixture) => !fixture.expectedFailure)
          .map(({ file }) => file.slice(file.lastIndexOf('.')).toLowerCase()),
      );
      const added = Object.keys(mimeTypes.webUnsupportedImage).filter(
        (extension) => !mimeTypes.isRaw(`a${extension}`) && !LEGACY_STILLS.has(extension),
      );
      expect(added.filter((extension) => !proven.has(extension))).toEqual([]);
    });
  });

  describe('raw', () => {
    it('should contain only lowercase mime types', () => {
      const keys = Object.keys(mimeTypes.raw);
      expect(keys).toEqual(keys.map((mimeType) => mimeType.toLowerCase()));

      const values = Object.values(mimeTypes.raw).flat();
      expect(values).toEqual(values.map((mimeType) => mimeType.toLowerCase()));
    });

    for (const [extension, v] of Object.entries(mimeTypes.raw)) {
      it(`should lookup ${extension}`, () => {
        expect(mimeTypes.lookup(`test.${extension}`)).toEqual(v[0]);
      });
    }
  });
});
