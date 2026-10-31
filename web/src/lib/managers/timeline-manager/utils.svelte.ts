const isNearViewport = ({ isInOrNearViewport }: { isInOrNearViewport: boolean }) => isInOrNearViewport;

export function filterIsInOrNearViewport<T extends { isInOrNearViewport: boolean }>(items: T[]) {
  // eslint-disable-next-line unicorn/no-array-callback-reference -- This private unary predicate ignores index/array arguments and is reused.
  return items.filter(isNearViewport);
}
