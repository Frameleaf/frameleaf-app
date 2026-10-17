export interface PaginationOptions {
  take: number;
  skip?: number;
}

export interface PaginationResult<T> {
  items: T[];
  hasNextPage: boolean;
}

export function paginationHelper<Entity extends object>(items: Entity[], take: number): PaginationResult<Entity> {
  const hasNextPage = items.length > take;
  if (Number.isSafeInteger(take) && take >= 0) {
    items.length = Math.min(items.length, take);
  } else {
    items.splice(take);
  }

  return { items, hasNextPage };
}
