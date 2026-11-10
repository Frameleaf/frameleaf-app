import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { StillRung } from 'src/types.js';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/**
 * FL-1356: the decoders tried, in order, when libvips cannot open a still. Each one writes a plain copy of
 * the picture (`output`, named with the converter's `extension`) that libvips can read; the original is only
 * ever read. Every command is given the path as an argument of its own, never through a shell.
 */
export type StillConverter = {
  rung: Exclude<StillRung, 'strict' | 'lenient' | 'embedded'>;
  extension: string;
  convert: (input: string, output: string, signal?: AbortSignal) => Promise<void>;
};

/**
 * ImageMagick decodes by content, and guesses wrongly for formats with no signature (a PICT goes to the TGA
 * coder). Naming the coder from the file's extension is the second try for these.
 */
const MAGICK_CODERS: Record<string, string> = {
  '.bmp': 'BMP',
  '.btf': 'TIFF',
  '.cin': 'CIN',
  '.cur': 'CUR',
  '.dds': 'DDS',
  '.dpx': 'DPX',
  '.exr': 'EXR',
  '.fits': 'FITS',
  '.ico': 'ICO',
  '.pam': 'PAM',
  '.pct': 'PICT',
  '.pcx': 'PCX',
  '.pict': 'PICT',
  '.qoi': 'QOI',
  '.sgi': 'SGI',
  '.tga': 'TGA',
  '.tif': 'TIFF',
  '.tiff': 'TIFF',
  '.xcf': 'XCF',
};

const JPEG_XR = new Set(['.jxr', '.wdp', '.hdp']);

const run = (command: string, args: string[], signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const lifetime = superviseMediaProcess(child, { signal });
    let failure: Error | undefined;
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      const error =
        lifetime.error() ?? failure ?? (code === 0 ? undefined : new Error(`${command} exited with ${code}`));
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

export const stillConverters = (filename: string): StillConverter[] => {
  const extension = extname(filename).toLowerCase();
  const converters: StillConverter[] = [];
  if (mimeTypes.lookup(filename) === 'image/jpeg') {
    // libjpeg-turbo reads what jpegli does not: arithmetic coding, 12-bit samples and lossless JPEG.
    converters.push({
      rung: 'djpeg',
      extension: '.ppm',
      convert: async (input, output, signal) => {
        await run('djpeg', ['-pnm', '-outfile', output, input], signal);
        // "P6 <width> <height> <maxval>". libvips shows a 12-bit sample (0 to 4095) as it stands, nearly
        // black, so those are left to ffmpeg, which scales them.
        const file = await open(output, 'r');
        try {
          const { buffer } = await file.read(Buffer.alloc(64), 0, 64, 0);
          const maxval = Number(buffer.toString('latin1').split(/\s+/, 4)[3]);
          if (maxval !== 255 && maxval !== 65_535) {
            throw new Error(`djpeg wrote samples up to ${maxval}`);
          }
        } finally {
          await file.close();
        }
      },
    });
  }
  if (JPEG_XR.has(extension)) {
    converters.push({
      rung: 'jxrlib',
      extension: '.tif',
      convert: (input, output, signal) => run('JxrDecApp', ['-i', input, '-o', output], signal),
    });
  }
  const coder = MAGICK_CODERS[extension];
  if (coder) {
    converters.push({
      rung: 'magick',
      extension: '.png',
      convert: (input, output, signal) =>
        run(
          'magick',
          // No disk cache: a picture too large for memory fails here instead of filling the temporary folder.
          ['-limit', 'disk', '0', `${coder}:${input}[0]`, '-define', 'png:compression-level=1', `PNG:${output}`],
          signal,
        ),
    });
  }
  converters.push({
    rung: 'ffmpeg',
    extension: '.png',
    convert: (input, output, signal) =>
      run(
        'ffmpeg',
        // Orientation is applied once, by the caller, from the original's own tags.
        [
          '-nostdin',
          '-v',
          'error',
          '-noautorotate',
          '-i',
          input,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-c:v',
          'png',
          '-f',
          'image2',
          '-update',
          '1',
          '-y',
          output,
        ],
        signal,
      ),
  });
  return converters;
};
