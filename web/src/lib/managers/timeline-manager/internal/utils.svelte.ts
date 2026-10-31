export function updateObject(target: unknown, source: unknown): boolean {
  if (!target || typeof target !== 'object' || !source || typeof source !== 'object') {
    return false;
  }
  const targetRecord = target as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  let updated = false;
  for (const key in sourceRecord) {
    if (!Object.hasOwn(sourceRecord, key) || key === '__proto__' || key === 'constructor') {
      continue;
    }
    const previous = targetRecord[key];
    const value = sourceRecord[key];
    if (previous === value) {
      continue;
    }
    if (
      Array.isArray(previous) &&
      Array.isArray(value) &&
      previous.length === value.length &&
      previous.every((item, index) => item === value[index])
    ) {
      continue;
    }
    if (
      previous &&
      value &&
      typeof previous === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(previous) &&
      !Array.isArray(value) &&
      !(previous instanceof Date) &&
      !(value instanceof Date)
    ) {
      if (updateObject(previous, value)) {
        updated = true;
      }
    } else {
      targetRecord[key] = value;
      updated = true;
    }
  }
  return updated;
}
export function isMismatched<T>(option: T | undefined, value: T): boolean {
  return option !== undefined && option !== value;
}
