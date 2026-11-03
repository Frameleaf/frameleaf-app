export type SourceOriginalIdentity = { sourceId: string; resourceKey: string };

const identity =
  /^frameleaf-source:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([a-f0-9]{64})$/u;

export const parseSourceOriginalPath = (value: string): SourceOriginalIdentity | undefined => {
  if (!value.toLowerCase().startsWith('frameleaf-source:')) return;
  const match = identity.exec(value);
  if (!match) throw new Error('source_reference_invalid');
  return { sourceId: match[1], resourceKey: match[2] };
};

export const sourceOriginalPath = ({ sourceId, resourceKey }: SourceOriginalIdentity): string => {
  const path = `frameleaf-source://${sourceId}/${resourceKey}`;
  parseSourceOriginalPath(path);
  return path;
};
