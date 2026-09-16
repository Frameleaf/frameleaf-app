import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// OpenAPI Generator 7.25 emits constructor calls for native Dart enum defaults.
// Use generated member names so escaping and enum naming stay generator-owned.
const directory = process.argv[2];
for (const name of await readdir(directory)) {
  if (!name.endsWith(".dart")) {
    continue;
  }
  const path = join(directory, name);
  const source = await readFile(path, "utf8");
  let patched = source;
  for (const [, enumName, members] of source.matchAll(
    /^enum (\w+) \{([\s\S]*?)^\}/gm,
  )) {
    for (const [, member, value] of members.matchAll(
      /^\s+(\w+)\._\(r?(.+)\)[,;]?$/gm,
    )) {
      patched = patched.replaceAll(
        `const ${enumName}._(${value})`,
        `${enumName}.${member}`,
      );
    }
  }
  if (patched !== source) {
    await writeFile(path, patched);
  }
}
