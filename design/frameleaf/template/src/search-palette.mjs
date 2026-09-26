// Search palette helpers: typed operators, typeahead suggestions and a "when" histogram.
// Operators compile to the same filter shape as search.mjs, so every result still runs
// through searchSampleAssets and the production metadata-search contract.

const fold = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en");
const unique = (values) => [...new Set(values)];
const DAY = 86_400_000;

/** Operators the palette understands. `hint` is shown in the syntax help and suggestions. */
export const searchOperators = [
  { key: "person", hint: "person:Jamie", label: "Person" },
  { key: "place", hint: "place:Banff", label: "Place" },
  { key: "tag", hint: "tag:water", label: "Tag" },
  { key: "type", hint: "type:video", label: "Media type" },
  { key: "camera", hint: "camera:Sony", label: "Camera" },
  { key: "lens", hint: "lens:24-70", label: "Lens" },
  { key: "rating", hint: "rating:4", label: "Rating (at least)" },
  { key: "is", hint: "is:favorite", label: "Favorites" },
  { key: "year", hint: "year:2026", label: "Year" },
  { key: "month", hint: "month:2026-08", label: "Month" },
  { key: "after", hint: "after:2026-08-12", label: "Taken after" },
  { key: "before", hint: "before:2026-08-15", label: "Taken before" },
  { key: "file", hint: "file:IMG_", label: "Filename contains" },
  { key: "text", hint: 'text:"lake agnes"', label: "Text in photo" },
  { key: "path", hint: "path:2026/", label: "Full path contains" },
];
const operatorKeys = new Set(searchOperators.map((operator) => operator.key));

// key:value, key:"quoted value", optional leading "-" to exclude.
const TOKEN = /(^|\s)(-?)([a-z]+):(?:"([^"]*)"|(\S+))/gi;

const byName = (
  items,
  value,
  name = (item) => item.name || item.label || item.id,
) =>
  (items || []).find(
    (item) => fold(item.id) === fold(value) || fold(name(item)) === fold(value),
  );

const isoDay = (time) => new Date(time).toISOString();

function dateRange(key, value) {
  if (key === "year" && /^\d{4}$/.test(value)) {
    const year = Number(value);
    return {
      gte: isoDay(Date.UTC(year, 0, 1)),
      lt: isoDay(Date.UTC(year + 1, 0, 1)),
    };
  }
  if (key === "month") {
    const match = value.match(/^(\d{4})-(\d{1,2})$/);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
    const [year, month] = [Number(match[1]), Number(match[2]) - 1];
    return {
      gte: isoDay(Date.UTC(year, month, 1)),
      lt: isoDay(Date.UTC(year, month + 1, 1)),
    };
  }
  if (key === "after" || key === "before") {
    const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return null;
    const time = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    );
    if (!Number.isFinite(time)) return null;
    return key === "after" ? { gte: isoDay(time + DAY) } : { lt: isoDay(time) };
  }
  return null;
}

/**
 * Splits palette input into free text and structured filters.
 * Unknown or unresolvable operators are left in the free text so nothing is silently dropped.
 * @returns {{ text: string, filter: object, tokens: {key:string, value:string, exclude:boolean, label:string, raw:string}[] }}
 */
export function parseSearchInput(input, catalog = {}) {
  const source = String(input ?? "").slice(0, 500);
  const filter = {};
  const tokens = [];
  const addArray = (field, id, exclude) => {
    const current = filter[field] || {};
    const bucket = exclude ? "none" : "all";
    filter[field] = {
      ...current,
      [bucket]: unique([...(current[bucket] || []), id]),
    };
  };
  const text = source.replace(
    TOKEN,
    (raw, lead, minus, rawKey, quoted, bare) => {
      const key = rawKey.toLowerCase();
      const value = (quoted ?? bare ?? "").trim();
      const exclude = minus === "-";
      if (!operatorKeys.has(key) || !value) return raw;
      let label = null;
      if (key === "person") {
        const person = byName(catalog.people, value);
        if (!person) return raw;
        addArray("personIds", person.id, exclude);
        label = person.name;
      } else if (key === "tag") {
        const tag = byName(catalog.tags, value);
        if (!tag) return raw;
        addArray("tagIds", tag.id, exclude);
        label = tag.label || tag.name || tag.id;
      } else if (key === "place") {
        const place =
          (catalog.places || []).find((item) => fold(item) === fold(value)) ??
          value;
        filter.city = exclude ? { ne: place } : { eq: place };
        label = place;
      } else if (key === "type") {
        const type = /^(photo|photos|image|images)$/i.test(value)
          ? "IMAGE"
          : /^videos?$/i.test(value)
            ? "VIDEO"
            : null;
        if (!type) return raw;
        filter.type = exclude ? { ne: type } : { eq: type };
        label = type === "IMAGE" ? "Photos" : "Videos";
      } else if (key === "camera") {
        const make = (catalog.makes || []).find(
          (item) => fold(item) === fold(value),
        );
        const model = make
          ? null
          : (catalog.models || []).find((item) =>
              fold(item).includes(fold(value)),
            );
        if (make) filter.make = exclude ? { ne: make } : { eq: make };
        else if (model) filter.model = exclude ? { ne: model } : { eq: model };
        else
          filter.make = exclude
            ? { notLike: `%${value}%` }
            : { like: `%${value}%` };
        label = `Camera: ${make || model || value}`;
      } else if (key === "lens") {
        filter.lensModel = exclude
          ? { notLike: `%${value}%` }
          : { like: `%${value}%` };
        label = `Lens: ${value}`;
      } else if (key === "rating") {
        if (!/^[0-5]$/.test(value) || exclude) return raw;
        filter.rating = { gte: Number(value) };
        label = `${value}★ or more`;
      } else if (key === "is") {
        if (!/^(fav|favou?rites?)$/i.test(value)) return raw;
        filter.isFavorite = { eq: !exclude };
        label = "Favorites";
      } else if (["year", "month", "after", "before"].includes(key)) {
        const range = dateRange(key, value);
        if (!range || exclude) return raw;
        filter.takenAt = { ...(filter.takenAt || {}), ...range };
        label =
          key === "after"
            ? `After ${value}`
            : key === "before"
              ? `Before ${value}`
              : value;
      } else {
        const field = {
          file: "originalFileName",
          text: "ocr",
          path: "originalPath",
        }[key];
        filter[field] = exclude
          ? { notLike: `%${value}%` }
          : { like: `%${value}%` };
        label = `${{ file: "File", text: "Text", path: "Path" }[key]}: “${value}”`;
      }
      tokens.push({
        key,
        value,
        exclude,
        raw: raw.trim(),
        label: `${exclude ? "Not " : ""}${label}`,
      });
      return lead;
    },
  );
  return { text: text.replace(/\s+/g, " ").trim(), filter, tokens };
}

/** Removes one operator token (by its raw text) from the input string. */
export function removeSearchToken(input, raw) {
  const index = input.indexOf(raw);
  if (index < 0) return input;
  return `${input.slice(0, index)}${input.slice(index + raw.length)}`
    .replace(/\s+/g, " ")
    .trim();
}

const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);

/**
 * Typeahead for the word being typed. Returns completions that replace that word with an
 * operator token, most relevant first. `catalog` entries may carry `count` from facets.
 */
export function suggestSearchTokens(input, catalog = {}, limit = 8) {
  const source = String(input ?? "");
  const match = source.match(/(^|\s)(-?)([^\s:]*)(?::("?)([^"]*))?$/);
  if (!match) return [];
  const [, , minus, head, , tail] = match;
  const fragmentStart = source.length - match[0].trimStart().length;
  const hasOperator = tail !== undefined;
  const typedKey = fold(head);
  const needle = fold(hasOperator ? tail : head);
  const replace = (token) =>
    `${source.slice(0, fragmentStart)}${minus}${token} `;
  const out = [];
  const push = (kind, key, value, label, count) => {
    if (hasOperator && typedKey !== key) return;
    const haystack = fold(value);
    if (
      needle &&
      !haystack.startsWith(needle) &&
      !haystack.includes(` ${needle}`) &&
      !(needle.length > 2 && haystack.includes(needle))
    )
      return;
    out.push({
      kind,
      label,
      detail: `${key}:${quote(value)}`,
      count,
      insert: replace(`${key}:${quote(value)}`),
      rank: haystack.startsWith(needle) ? 0 : 1,
    });
  };
  if (!hasOperator && needle.length < 1) return [];
  // Unnamed people have no name to type, so they cannot be a person: token.
  for (const person of (catalog.people || []).filter((p) => p.name))
    push("person", "person", person.name, person.name, person.count);
  for (const place of catalog.places || [])
    push(
      "place",
      "place",
      place.value ?? place,
      place.value ?? place,
      place.count,
    );
  for (const tag of catalog.tags || [])
    push(
      "tag",
      "tag",
      tag.label || tag.name || tag.id,
      tag.label || tag.name || tag.id,
      tag.count,
    );
  for (const make of catalog.makes || [])
    push(
      "camera",
      "camera",
      make.value ?? make,
      make.value ?? make,
      make.count,
    );
  for (const year of catalog.years || [])
    push(
      "year",
      "year",
      String(year.value ?? year),
      String(year.value ?? year),
      year.count,
    );
  push("type", "type", "photo", "Photos", catalog.typeCounts?.IMAGE);
  push("type", "type", "video", "Videos", catalog.typeCounts?.VIDEO);
  push("is", "is", "favorite", "Favorites", catalog.favoriteCount);
  if (!hasOperator)
    for (const operator of searchOperators)
      if (operator.key.startsWith(typedKey) && typedKey.length >= 2)
        out.push({
          kind: "operator",
          label: `${operator.label}`,
          detail: operator.hint,
          insert: `${source.slice(0, fragmentStart)}${minus}${operator.key}:`,
          rank: 2,
        });
  return out
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (b.count ?? -1) - (a.count ?? -1) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, limit)
    .map(({ rank, ...item }) => item);
}

/**
 * Buckets matches by capture date so large result sets can be narrowed visually.
 * Granularity adapts to the span: days (≤ 62 days), months (≤ 3 years) or years.
 */
export function dateHistogram(assets, { field = "takenAt" } = {}) {
  const times = (assets || [])
    .map((asset) => Date.parse(asset?.[field] ?? asset?.date))
    .filter(Number.isFinite);
  if (!times.length) return { unit: null, buckets: [] };
  const min = Math.min(...times),
    max = Math.max(...times);
  const span = max - min;
  const unit =
    span <= 62 * DAY ? "day" : span <= 3 * 366 * DAY ? "month" : "year";
  const startOf = (time) => {
    const date = new Date(time);
    const [y, m, d] = [
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    ];
    return unit === "day"
      ? Date.UTC(y, m, d)
      : unit === "month"
        ? Date.UTC(y, m, 1)
        : Date.UTC(y, 0, 1);
  };
  const next = (time) => {
    const date = new Date(time);
    const [y, m, d] = [
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    ];
    return unit === "day"
      ? Date.UTC(y, m, d + 1)
      : unit === "month"
        ? Date.UTC(y, m + 1, 1)
        : Date.UTC(y + 1, 0, 1);
  };
  const counts = new Map();
  for (const time of times)
    counts.set(startOf(time), (counts.get(startOf(time)) || 0) + 1);
  const buckets = [];
  // Include empty buckets so gaps in the library read as gaps.
  for (
    let time = startOf(min);
    time <= max && buckets.length < 400;
    time = next(time)
  ) {
    const date = new Date(time);
    buckets.push({
      start: new Date(time).toISOString(),
      end: new Date(next(time)).toISOString(),
      count: counts.get(time) || 0,
      label:
        unit === "day"
          ? date.toLocaleDateString("en", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })
          : unit === "month"
            ? date.toLocaleDateString("en", {
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              })
            : String(date.getUTCFullYear()),
    });
  }
  return { unit, buckets };
}
