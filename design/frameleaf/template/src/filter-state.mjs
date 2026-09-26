export const customConditionValue = "__custom_condition__";
export const setGroupLabels = { any: "Any of", all: "All of", none: "Exclude" };

// Editing one group never changes the other groups in the same condition.
export function updateSetGroup(condition, group, values) {
  if (!Object.hasOwn(setGroupLabels, group)) return condition;
  const next = { ...condition };
  if (values.length) next[group] = [...new Set(values)];
  else delete next[group];
  return Object.keys(next).length ? next : null;
}

export function moveSetGroup(condition, from, to) {
  if (
    from === to ||
    !Object.hasOwn(setGroupLabels, from) ||
    !Object.hasOwn(setGroupLabels, to)
  )
    return condition;
  const values = condition?.[from] || [];
  const next = { ...condition };
  delete next[from];
  if (values.length) next[to] = [...new Set([...(next[to] || []), ...values])];
  return Object.keys(next).length ? next : null;
}

const isEmpty = (condition) =>
  !condition || Object.keys(condition).length === 0;
const isOnly = (condition, operator) =>
  !!condition &&
  Object.keys(condition).length === 1 &&
  Object.hasOwn(condition, operator);

export function equalityControlValue(
  condition,
  accepts = (value) => typeof value === "string" && value.length > 0,
) {
  if (isEmpty(condition)) return "";
  return isOnly(condition, "eq") && accepts(condition.eq)
    ? String(condition.eq)
    : customConditionValue;
}

export function ratingControlValue(condition) {
  if (isEmpty(condition)) return "";
  if (isOnly(condition, "eq")) {
    if (condition.eq === null) return "null";
    if (
      Number.isInteger(condition.eq) &&
      condition.eq >= -1 &&
      condition.eq <= 5
    )
      return String(condition.eq);
  }
  if (
    isOnly(condition, "gte") &&
    Number.isInteger(condition.gte) &&
    condition.gte >= 0 &&
    condition.gte <= 5
  )
    return `min${condition.gte}`;
  return customConditionValue;
}

export function ratingConditionForValue(value) {
  if (value === "") return null;
  if (value === "null") return { eq: null };
  if (/^(?:-1|[0-5])$/.test(value)) return { eq: Number(value) };
  if (/^min[0-5]$/.test(value)) return { gte: Number(value.slice(3)) };
  return undefined;
}

function calendarDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value))
    return "";
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day
    ? day
    : "";
}

export function captureDateControlValue(condition, operator) {
  if (condition?.[operator] !== undefined)
    return calendarDay(condition[operator]);
  if (operator !== "lte" || typeof condition?.lt !== "string") return "";
  const day = calendarDay(condition.lt);
  if (!day) return "";
  // The phrase resolver uses a UTC midnight exclusive end. Subtracting one
  // millisecond also keeps a custom intraday end on its actual calendar day.
  const boundary = new Date(
    condition.lt.length === 10 ? `${day}T00:00:00.000Z` : condition.lt,
  );
  if (!Number.isFinite(boundary.getTime())) return "";
  return new Date(boundary.getTime() - 1).toISOString().slice(0, 10);
}

export function updateCaptureDate(condition, operator, value) {
  if (
    !["gte", "lte"].includes(operator) ||
    (value && calendarDay(value) !== value)
  )
    return condition;
  const next = { ...condition };
  delete next[operator];
  // An explicit edit replaces only this endpoint, including its strict variant.
  // Changing From therefore retains an existing exclusive upper bound.
  delete next[operator === "gte" ? "gt" : "lt"];
  if (value) next[operator] = value;
  return Object.keys(next).length ? next : null;
}

export function captureDateHasCustomCondition(condition) {
  if (condition?.lt !== undefined && condition?.lte !== undefined) return true;
  return Object.entries(condition || {}).some(([operator, value]) => {
    if (!["gte", "lte", "lt"].includes(operator) || !calendarDay(value))
      return true;
    if (operator === "lt")
      return !/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(value);
    if (operator === "lte" && value.length > 10) return true;
    // Date-only controls cannot fully represent an intraday timestamp.
    return (
      value.length > 10 &&
      !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value)
    );
  });
}

// Quick toggles ("Not in any album", "Untagged") set one boolean equality and
// clear it again; any other condition on the field is left to the chip.
export function flagToggleActive(condition, value) {
  return isOnly(condition, "eq") && condition.eq === value;
}
export function toggleFlagCondition(condition, value) {
  if (typeof value !== "boolean") return condition;
  return flagToggleActive(condition, value) ? null : { eq: value };
}

// Enrichment status selects (description / sensitivity review) accept one of a
// fixed vocabulary; anything else is shown as a custom condition.
export function statusControlValue(condition, statuses) {
  return equalityControlValue(
    condition,
    (value) => typeof value === "string" && statuses.includes(value),
  );
}
export function statusConditionForValue(value, statuses) {
  if (value === "") return null;
  return statuses.includes(value) ? { eq: value } : undefined;
}
