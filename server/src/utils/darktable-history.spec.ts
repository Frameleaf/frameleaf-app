import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DarktableDevelopRecipeSchema } from 'src/dtos/asset-develop.dto.js';
import { prepareNativeHistory } from 'src/utils/darktable-renderer.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-history-double-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
/** Explicit SQLite double for adapter transactions; this does not qualify darktable image output. */
function fixture() {
  const path = join(directory, 'library.db');
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE images(id INTEGER, history_end INTEGER, orientation INTEGER); INSERT INTO images VALUES(1,3,0); CREATE TABLE module_order(imgid INTEGER, version INTEGER, iop_list TEXT); INSERT INTO module_order VALUES(1,4,NULL); CREATE TABLE history(imgid INTEGER, num INTEGER, operation TEXT, module INTEGER, op_params BLOB, enabled INTEGER, blendop_params BLOB, blendop_version INTEGER, multi_priority INTEGER, multi_name TEXT, multi_name_hand_edited INTEGER)',
  );
  const put = (num: number, op: string, version: number, bytes: Buffer) =>
    db.prepare('INSERT INTO history VALUES(1,?,?,?, ?,1,NULL,14,0,NULL,0)').run(num, op, version, bytes);
  put(0, 'exposure', 7, Buffer.alloc(28));
  const wb = Buffer.alloc(20);
  for (const [index, value] of [2, 1, 1.5, 0].entries()) wb.writeFloatLE(value, index * 4);
  put(1, 'temperature', 4, wb);
  const orientation = Buffer.alloc(4);
  orientation.writeInt32LE(-1);
  put(2, 'flip', 2, orientation);
  db.close();
  return path;
}
it('inserts full native history, camera-relative white balance, geometry and raster-linked local modules', () => {
  const path = fixture();
  const recipe = DarktableDevelopRecipeSchema.parse({
    version: 2,
    renderer: 'darktable/5.6.1',
    exposureEV: 1,
    whiteBalance: { red: 1.25, green: 1, blue: 0.8 },
    shadows: 20,
    highlights: -25,
    curve: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.6 },
      { x: 1, y: 1 },
    ],
    saturation: 1.1,
    noiseThreshold: 0.02,
    sharpen: { radius: 2, amount: 0.5, threshold: 0.5 },
    crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    rotation: 90,
    straighten: 2,
    masks: [
      {
        id: 'local',
        kind: 'radial',
        x: 0.5,
        y: 0.5,
        coordinates: 'sensor-active',
        adjustments: { exposureEV: 2, shadows: 10 },
      },
    ],
  });
  prepareNativeHistory(path, recipe, [join(directory, 'mask.png')]);
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT * FROM history ORDER BY num').all();
  const wb = Buffer.from(rows.find((row) => row.operation === 'temperature')!.op_params as Uint8Array);
  expect(wb.readFloatLE(0)).toBe(2.5);
  expect(wb.readFloatLE(8)).toBeCloseTo(1.2);
  expect(wb.readInt32LE(16)).toBe(2);
  expect(Buffer.from(rows.find((row) => row.operation === 'flip')!.op_params as Uint8Array).readInt32LE(0)).toBe(5);
  const local = rows.find((row) => row.operation === 'exposure' && row.multi_priority === 1)!;
  expect(Buffer.from(local.blendop_params as Uint8Array).readInt32LE(408)).toBe(1);
  expect(Buffer.from(local.blendop_params as Uint8Array).toString('utf8', 388, 398)).toBe('rasterfile');
  const order = String(db.prepare('SELECT iop_list FROM module_order').get()!.iop_list);
  expect(order.indexOf('rasterfile,1')).toBeLessThan(order.indexOf('exposure,1'));
  expect(order).toContain('shadhi,1');
  expect(order.endsWith('gamma,0')).toBe(true);
  expect(db.prepare('SELECT history_end FROM images').get()!.history_end).toBe(rows.length);
  db.close();
});
it('rolls back earlier exposure writes if a later native module or camera coefficient is unsupported', () => {
  const path = fixture();
  const db = new DatabaseSync(path);
  const old = db.prepare("SELECT op_params FROM history WHERE operation='exposure'").get()!.op_params;
  db.close();
  expect(() =>
    prepareNativeHistory(path, {
      version: 2,
      renderer: 'darktable/5.6.1',
      exposureEV: 3,
      whiteBalance: { red: 8, green: 1, blue: 1 },
    }),
  ).toThrow('coefficient out of range');
  const check = new DatabaseSync(path);
  expect(check.prepare("SELECT op_params FROM history WHERE operation='exposure'").get()!.op_params).toEqual(old);
  expect(check.prepare('SELECT history_end FROM images').get()!.history_end).toBe(3);
  check.close();
});
it('rejects unsafe native history priorities and rolls back the exposure write', () => {
  const path = fixture();
  const db = new DatabaseSync(path);
  const exposure = db.prepare("SELECT op_params FROM history WHERE operation='exposure'").get()!.op_params;
  db.prepare('UPDATE module_order SET version = 0, iop_list = ?').run(
    'rawprepare,0,colorbalance,0,exposure,9007199254740992,gamma,0',
  );
  db.close();
  expect(() =>
    prepareNativeHistory(path, {
      version: 2,
      renderer: 'darktable/5.6.1',
      exposureEV: 3,
      contrast: 1.1,
    }),
  ).toThrow(/^Unsupported native module order$/);
  const check = new DatabaseSync(path);
  expect(check.prepare("SELECT op_params FROM history WHERE operation='exposure'").get()!.op_params).toEqual(exposure);
  expect(check.prepare('SELECT history_end FROM images').get()!.history_end).toBe(3);
  check.close();
});
