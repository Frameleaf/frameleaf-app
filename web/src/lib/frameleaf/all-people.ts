/**
 * FL-1803: every page of a paged people read, in order. A picker or a list of choices that reads
 * only the first page silently leaves out everyone after it.
 */
export const readEveryPage = async <T extends { id: string }>(
  read: (page: number) => Promise<{ people: T[]; hasNextPage?: boolean }>,
): Promise<T[]> => {
  const all: T[] = [];
  const known = new Set<string>();
  for (let page = 1; ; page++) {
    const result = await read(page);
    const added = result.people.filter(({ id }) => !known.has(id));
    for (const person of added) {
      known.add(person.id);
      all.push(person);
    }
    // A page that adds nobody new means the list shifted under us; stop rather than loop.
    if (!result.hasNextPage || added.length === 0) {
      return all;
    }
  }
};
