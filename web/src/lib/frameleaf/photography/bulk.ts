export function parseBulkClients(text: string) {
  return text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const fields = /^\s*(?:"((?:[^"]|"")*)"|([^",]+))\s*,\s*"?([^"\s,]+)"?\s*$/.exec(line);
      const clientName = (fields?.[1]?.replaceAll('""', '"') ?? fields?.[2] ?? '').trim();
      const clientEmail = fields?.[3] ?? '';
      return {
        index,
        clientName,
        clientEmail,
        valid:
          clientName.length > 0 &&
          clientName.length <= 200 &&
          clientEmail.length <= 254 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail),
      };
    });
}
