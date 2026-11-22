import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { SharpOperations } from 'src/queue/sharp-operations.js';
import { type ScanPoint, fitScanCropRect } from 'src/utils/scan-split.js';

describe('renderScanCrop (FL-923)', () => {
  const sut = new SharpOperations();
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scan-crop-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const WIDTH = 400;
  const HEIGHT = 300;
  const CENTER: ScanPoint = [620, 430];

  /** Corners (top-left, top-right, bottom-right, bottom-left) of the print turned `degrees` clockwise. */
  const corners = (degrees: number): ScanPoint[] => {
    const cos = Math.cos((degrees * Math.PI) / 180);
    const sin = Math.sin((degrees * Math.PI) / 180);
    return (
      [
        [-WIDTH / 2, -HEIGHT / 2],
        [WIDTH / 2, -HEIGHT / 2],
        [WIDTH / 2, HEIGHT / 2],
        [-WIDTH / 2, HEIGHT / 2],
      ] as ScanPoint[]
    ).map(([x, y]) => [CENTER[0] + x * cos - y * sin, CENTER[1] + x * sin + y * cos]);
  };

  /** A white 1200x900 scan with one 400x300 print, red on its left half and blue on its right, turned `degrees`. */
  const scan = async (degrees: number, name: string, sideways = false) => {
    const half = { width: WIDTH / 2, height: HEIGHT, channels: 3 as const };
    const print = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#0000ff' } })
      .composite([{ input: { create: { ...half, background: '#ff0000' } }, left: 0, top: 0 }])
      .png()
      .toBuffer();
    const turned = await sharp(print)
      .rotate(degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer({ resolveWithObject: true });
    const upright = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#ffffff' } })
      .composite([
        {
          input: turned.data,
          left: Math.round(CENTER[0] - turned.info.width / 2),
          top: Math.round(CENTER[1] - turned.info.height / 2),
        },
      ])
      .png()
      .toBuffer();
    const path = join(dir, name);
    // sideways: stored turned a quarter turn back, with the EXIF orientation that displays it upright
    await (sideways ? sharp(upright).rotate(270).withMetadata({ orientation: 6 }) : sharp(upright)).png().toFile(path);
    return path;
  };

  const pixel = async (path: string, x: number, y: number) => {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    const offset = (y * info.width + x) * info.channels;
    return [...data.subarray(offset, offset + 3)];
  };
  const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
  const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60;

  it.each([10, -7, 0])('cuts a print turned %i degrees out straight at full size', async (degrees) => {
    const output = join(dir, `straight-${degrees}.jpg`);
    const size = await sut.renderScanCrop(
      await scan(degrees, `scan-${degrees}.png`),
      output,
      fitScanCropRect(corners(degrees)),
      0,
    );
    expect(size).toEqual({ width: WIDTH, height: HEIGHT });
    await expect(sharp(output).metadata()).resolves.toMatchObject({ format: 'jpeg', width: WIDTH, height: HEIGHT });
    // one degree off would show 5 pixels of white scanner lid in a corner
    for (const [x, y] of [
      [4, 4],
      [4, HEIGHT - 5],
      [WIDTH / 2 - 6, HEIGHT / 2],
    ])
      expect(isRed(await pixel(output, x, y))).toBe(true);
    for (const [x, y] of [
      [WIDTH - 5, 4],
      [WIDTH - 5, HEIGHT - 5],
      [WIDTH / 2 + 6, HEIGHT / 2],
    ])
      expect(isBlue(await pixel(output, x, y))).toBe(true);
  });

  it('applies the quarter turn after straightening', async () => {
    const output = join(dir, 'quarter.jpg');
    const size = await sut.renderScanCrop(await scan(10, 'scan-q.png'), output, fitScanCropRect(corners(10)), 90);
    expect(size).toEqual({ width: HEIGHT, height: WIDTH });
    // turned clockwise, the red left half is at the top
    expect(isRed(await pixel(output, HEIGHT / 2, 5))).toBe(true);
    expect(isBlue(await pixel(output, HEIGHT / 2, WIDTH - 6))).toBe(true);
  });

  it('reads the quad in the pixels of the scan as it is displayed', async () => {
    const output = join(dir, 'sideways.jpg');
    await sut.renderScanCrop(await scan(10, 'scan-s.png', true), output, fitScanCropRect(corners(10)), 0);
    await expect(sharp(output).metadata()).resolves.toMatchObject({ width: WIDTH, height: HEIGHT });
    expect(isRed(await pixel(output, 4, 4))).toBe(true);
    expect(isBlue(await pixel(output, WIDTH - 5, HEIGHT - 5))).toBe(true);
  });

  it('fills what lies past the edge of the scan with white', async () => {
    const output = join(dir, 'edge.jpg');
    // a 200x100 box whose left half is off the scan
    const size = await sut.renderScanCrop(
      await scan(0, 'scan-e.png'),
      output,
      { centerX: 0, centerY: 50, width: 200, height: 100, angle: 0 },
      0,
    );
    expect(size.height).toBe(100);
    expect(size.width).toBeLessThanOrEqual(200);
    expect(await pixel(output, size.width - 1, 50)).toEqual([255, 255, 255]);
  });

  it('refuses to write over the scan, a turn that is not a quarter turn or an empty box', async () => {
    const input = await scan(0, 'scan-r.png');
    const rect = fitScanCropRect(corners(0));
    await expect(sut.renderScanCrop(input, input, rect, 0)).rejects.toThrow('INVALID_SCAN_CROP');
    await expect(sut.renderScanCrop(input, join(dir, 'x.jpg'), rect, 45)).rejects.toThrow('INVALID_SCAN_CROP');
    await expect(sut.renderScanCrop(input, join(dir, 'x.jpg'), { ...rect, width: 0 }, 0)).rejects.toThrow(
      'INVALID_SCAN_CROP',
    );
  });
});
