import sharp from 'sharp';
// Standalone Node child has no application alias loader.
// eslint-disable-next-line no-restricted-imports
import { SharpOperations } from './sharp-operations.js';
// eslint-disable-next-line no-restricted-imports
import {
  SHARP_OPERATIONS,
  SharpDecodeError,
  SharpResourceLimitError,
  assertSharpPixels,
  sharpPayloadBytes,
} from './sharp-protocol.js';
import type { SharpRequest, SharpResponse } from 'src/queue/sharp-protocol.js';

// Bound native threads per child; the parent owns process concurrency and admission.
// eslint-disable-next-line import-x/no-named-as-default-member
sharp.concurrency(1);
// eslint-disable-next-line import-x/no-named-as-default-member
sharp.cache({ files: 0, memory: 0, items: 0 });
let busy = false;
const send = (message: SharpResponse) => process.send?.(message);
process.once('disconnect', () => process.exit(0));
process.on('message', (request: SharpRequest) => {
  if (busy) {
    return process.exit(1);
  }
  busy = true;
  void execute(request).finally(() => {
    busy = false;
  });
});
send({ type: 'ready' });

async function execute(request: SharpRequest) {
  const { id, operation, args, maxPixels, maxBytes } = request;
  try {
    if (!SHARP_OPERATIONS.includes(operation)) {
      throw new Error('Unknown Sharp operation');
    }
    if (sharpPayloadBytes(args) > maxBytes) {
      throw new SharpResourceLimitError('input buffer is too large');
    }
    // Raw dimensions and grid canvas have no encoded header for libvips to validate.
    const raw = (
      operation === 'renderDevelopGeometry' || operation === 'encodeDevelopOutput'
        ? args[1]
        : (args[1] as { raw?: unknown } | undefined)?.raw
    ) as { width: number; height: number } | undefined;
    if (raw) {
      assertSharpPixels(raw.width, raw.height, maxPixels);
    }
    switch (operation) {
      case 'renderDevelopGeometry': {
        const plan = args[2] as { oriented: { width: number; height: number }; straighten: number };
        const { width, height } = plan.oriented;
        assertSharpPixels(width, height, maxPixels);
        if (plan.straighten !== 0) {
          const theta = (Math.abs(plan.straighten) * Math.PI) / 180;
          assertSharpPixels(
            Math.ceil(width * Math.cos(theta) + height * Math.sin(theta)),
            Math.ceil(width * Math.sin(theta) + height * Math.cos(theta)),
            maxPixels * 2,
          );
        }

        break;
      }
      case 'composeImageGrid': {
        const { cols, rows, cellSize } = args[1] as { cols: number; rows: number; cellSize: number };
        if ([cols, rows, cellSize].some((value) => !(Number.isSafeInteger(value) && value > 0))) {
          throw new SharpResourceLimitError('invalid grid dimensions');
        }
        assertSharpPixels(cols * cellSize, rows * cellSize, maxPixels);
        if (cols * rows > 1024) {
          throw new SharpResourceLimitError('grid exceeds 1024 cells');
        }

        break;
      }
      case 'composeFilmstrip': {
        const { columns, rows, tileWidth, tileHeight } = args[1] as {
          columns: number;
          rows: number;
          tileWidth: number;
          tileHeight: number;
        };
        if ([columns, rows, tileWidth, tileHeight].some((value) => !(Number.isSafeInteger(value) && value > 0))) {
          throw new SharpResourceLimitError('invalid filmstrip dimensions');
        }
        assertSharpPixels(columns * tileWidth, rows * tileHeight, maxPixels);
        if (columns * rows > 1024 || columns * tileWidth > 16_383 || rows * tileHeight > 16_383) {
          throw new SharpResourceLimitError('filmstrip exceeds its bounds');
        }

        break;
      }
      // No default
    }
    let completed = 0;
    const operations = new SharpOperations(
      maxPixels,
      () => send({ type: 'progress', id, completed: ++completed }),
      maxBytes,
    );
    const perform = operations[operation].bind(operations) as (...values: unknown[]) => Promise<unknown>;
    const value = await perform(...args);
    if (sharpPayloadBytes(value) > maxBytes) {
      throw new SharpResourceLimitError('output buffer is too large');
    }
    send({ type: 'result', id, value, workerLifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024 });
  } catch (error) {
    send({
      type: 'failure',
      id,
      workerLifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
      resourceLimit:
        error instanceof SharpResourceLimitError ||
        (error instanceof Error && error.message.includes('Input image exceeds pixel limit')),
      decodeFailure: error instanceof SharpDecodeError,
    });
  }
}
