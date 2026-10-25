const GENERATED_DESCRIPTION_PREFIX = 'AI description:';
export const getGeneratedDescriptionBlock = (description: string) => {
  const trimmed = description.trim();
  return trimmed ? `${GENERATED_DESCRIPTION_PREFIX} ${trimmed}` : undefined;
};
export const withoutGeneratedDescriptionBlocks = (description: string, generatedDescriptions: string[]) => {
  const blocks = new Set(
    generatedDescriptions
      .map((generatedDescription) => getGeneratedDescriptionBlock(generatedDescription))
      .filter((block): block is string => !!block),
  );
  if (blocks.size === 0) {
    return description.trim();
  }
  return description
    .split(/\n{2,}/)
    .filter((part) => !blocks.has(part.trim()))
    .join('\n\n')
    .trim();
};
