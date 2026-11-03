import path from 'node:path';
import sanitize from 'sanitize-filename';

const basename = (name: string) => path.posix.basename(name.replaceAll('\\', '/'));
const truncateBytes = (value: string, limit: number) => {
  let result = '',
    bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result;
};
export const batchExportName = (fileName: string, exportId: string) => {
  const name = sanitize(basename(fileName)) || 'original';
  const originalExtension = path.extname(name);
  const extension = truncateBytes(originalExtension, 16);
  const suffix = `__fl_${exportId}${extension}`;
  return `${truncateBytes(path.basename(name, originalExtension), 255 - Buffer.byteLength(suffix) - 4)}${suffix}`;
};
const stem = (name: string) => path.parse(basename(name)).name.normalize('NFC').toLowerCase();
export type BatchMatchItem = { id: string; exportId: string; fileName: string; exportName: string };
export type BatchReturnFile = { fileName: string; checksum: string; itemId?: string; skip?: boolean };
export const matchBatchReturns = (items: BatchMatchItem[], files: BatchReturnFile[]) => {
  const byId = new Map<string, BatchMatchItem[]>();
  const byExport = new Map<string, BatchMatchItem[]>();
  const byStem = new Map<string, BatchMatchItem[]>();
  const add = (map: Map<string, BatchMatchItem[]>, key: string, item: BatchMatchItem) => {
    const matches = map.get(key) ?? [];
    matches.push(item);
    map.set(key, matches);
  };
  for (const item of items) {
    add(byId, item.id, item);
    add(byExport, item.exportId, item);
    for (const name of new Set([stem(item.fileName), stem(item.exportName)])) add(byStem, name, item);
  }
  const result = files.map((file, index) => {
    const base = { index, fileName: file.fileName, checksum: file.checksum, itemId: null as string | null };
    if (file.skip || /\.(json|xmp|aae)$/i.test(file.fileName)) return { ...base, status: 'skipped' as const };
    const identity = /__fl_([\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12})/i
      .exec(basename(file.fileName))?.[1]
      ?.toLowerCase();
    const candidates = file.itemId
      ? (byId.get(file.itemId) ?? [])
      : identity
        ? (byExport.get(identity) ?? [])
        : (byStem.get(stem(file.fileName)) ?? []);
    return {
      ...base,
      itemId: candidates.length === 1 ? candidates[0].id : null,
      status:
        candidates.length === 1
          ? ('matched' as const)
          : candidates.length > 1
            ? ('ambiguous' as const)
            : ('unmatched' as const),
    };
  });
  const counts = new Map<string, number>();
  for (const row of result) if (row.itemId) counts.set(row.itemId, (counts.get(row.itemId) ?? 0) + 1);
  return result.map((row) =>
    row.itemId && counts.get(row.itemId)! > 1 ? { ...row, itemId: null, status: 'ambiguous' as const } : row,
  );
};
