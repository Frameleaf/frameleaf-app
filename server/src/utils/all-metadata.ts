import { BinaryField } from 'exiftool-vendored';

export type RawMetadataGroup = { name: string; tags: { key: string; value: string }[] };

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const hiddenGroups = new Set(['ExifTool', 'System']);
const fileDetails = new Set(['FileName', 'Directory', 'FilePath', 'SourceFile', 'Error', 'Warning']);
const creditDetails = new Set(['Artist', 'Creator', 'By-line', 'ByLine', 'Author', 'Authors']);

export const collectAllMetadata = (
  sources: { name: string; values: Record<string, unknown> }[],
  shared: boolean,
): { groups: RawMetadataGroup[]; truncated: boolean } => {
  const groups = new Map<string, RawMetadataGroup>();
  let bytes = 40;
  let truncated = false;

  for (const { name, values } of sources) {
    for (const [qualified, raw] of Object.entries(values)) {
      const parts = qualified.split(':');
      if (parts.length < 2 || raw === null || raw === undefined) continue;
      const [family, ...rest] = parts;
      const tag = rest.at(-1)!;
      if (hiddenGroups.has(family) || fileDetails.has(tag) || (shared && creditDetails.has(tag))) continue;

      const value =
        raw instanceof BinaryField
          ? `(Binary data ${raw.bytes} bytes)`
          : typeof raw === 'string'
            ? raw
            : JSON.stringify(raw);
      const key = rest.join(':');
      const groupName = `${name}: ${family}`;
      const existing = groups.get(groupName);
      const tagBytes = Buffer.byteLength(JSON.stringify({ key, value })) + 1;
      const groupBytes = existing ? 0 : Buffer.byteLength(JSON.stringify({ name: groupName, tags: [] })) + 1;
      if (bytes + tagBytes + groupBytes > MAX_RESPONSE_BYTES) {
        truncated = true;
        continue;
      }

      bytes += tagBytes + groupBytes;
      const group = existing ?? { name: groupName, tags: [] };
      if (!existing) groups.set(groupName, group);
      group.tags.push({ key, value });
    }
  }

  return { groups: groups.values().toArray(), truncated };
};
