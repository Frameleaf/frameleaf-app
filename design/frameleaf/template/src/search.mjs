// Local sample metadata only. No API, image inference, OCR generation or embeddings.
const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const string = (value) => (typeof value === "string" ? value : "");
const fold = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
const unique = (values) => [...new Set(values)];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clone = (value) => structuredClone(value);
const typeOf = (value) =>
  ["photo", "photos", "image", "images"].includes(fold(value))
    ? "IMAGE"
    : ["video", "videos"].includes(fold(value))
      ? "VIDEO"
      : value;
const knownFields = new Set([
  "personIds",
  "tagIds",
  "albumIds",
  "type",
  "takenAt",
  "createdAt",
  "updatedAt",
  "city",
  "state",
  "country",
  "make",
  "model",
  "lensModel",
  "rating",
  "isFavorite",
  "visibility",
  "hasPeople",
  "hasAlbums",
  "hasTags",
  "originalFileName",
  "description",
  "ocr",
  "originalPath",
  "descriptionStatus",
  "sensitiveStatus",
]);
export const descriptionStatuses = ["generated", "manual", "missing", "failed"];
export const sensitiveStatuses = ["reviewed", "needs-review", "overridden"];
const statusFields = {
  descriptionStatus: descriptionStatuses,
  sensitiveStatus: sensitiveStatuses,
};
/** Derived from the asset's enrichment record; a description without one counts as manual. */
export function descriptionStatus(asset) {
  const status = fold(asset?.enrichment?.description?.status);
  if (status === "failed") return "failed";
  if (!string(asset?.description).trim()) return "missing";
  return status === "generated" ? "generated" : "manual";
}
export function sensitiveStatus(asset) {
  const status = fold(asset?.enrichment?.sensitive?.status).replace(/_/g, "-");
  if (sensitiveStatuses.includes(status)) return status;
  return record(asset?.enrichment?.sensitive) ? "reviewed" : null;
}
const arrayFields = new Set(["personIds", "tagIds", "albumIds"]);
const dateFields = new Set(["takenAt", "createdAt", "updatedAt"]);
const booleanFields = new Set([
  "isFavorite",
  "hasPeople",
  "hasAlbums",
  "hasTags",
]);
const catalog = (items) =>
  Array.isArray(items)
    ? items.filter((item) => record(item) && typeof item.id === "string")
    : [];
const labelFor = (items, id) => {
  const item = catalog(items).find((item) => item.id === id);
  if (item && "name" in item && !item.name?.trim() && !item.label)
    return "Unnamed person";
  return item?.name || item?.label || String(id);
};
const idFor = (items, value) =>
  catalog(items).find(
    (item) =>
      fold(item.id) === fold(value) ||
      fold(item.name || item.label) === fold(value),
  )?.id || value;

export const sampleSearchModeDescriptions = {
  text: "Matches words in sample filenames, descriptions, people, tags and other metadata.",
  semantic:
    "Semantic demonstration: words in sample descriptions and labels. No embeddings or image inference.",
  filename: "Matches existing sample filenames only.",
  description: "Matches existing sample descriptions only.",
  ocr: "Matches supplied sample OCR text. No text recognition is run.",
  fullPath: "Matches supplied sample original paths only.",
};

function normalizeFilter(input, options) {
  if (input === undefined) return {};
  if (!record(input)) return { unsupportedInvalidFilter: { eq: true } };
  const result = clone(input);
  if (result.person !== undefined && result.personIds === undefined) {
    result.personIds =
      record(result.person) && typeof result.person.eq === "string"
        ? { any: [idFor(options.people, result.person.eq)] }
        : result.person;
  }
  if (result.favorite !== undefined && result.isFavorite === undefined)
    result.isFavorite = result.favorite;
  if (result.isArchived !== undefined && result.visibility === undefined) {
    const archived = record(result.isArchived)
      ? result.isArchived.eq
      : result.isArchived;
    result.visibility =
      typeof archived === "boolean"
        ? { [archived ? "eq" : "ne"]: "archive" }
        : result.isArchived;
  }
  if (result.isNotInAlbum !== undefined && result.hasAlbums === undefined) {
    const notInAlbum = record(result.isNotInAlbum)
      ? result.isNotInAlbum.eq
      : result.isNotInAlbum;
    result.hasAlbums =
      typeof notInAlbum === "boolean"
        ? { eq: !notInAlbum }
        : result.isNotInAlbum;
  }
  for (const alias of ["person", "favorite", "isArchived", "isNotInAlbum"])
    delete result[alias];
  if (record(result.type)) {
    result.type = Object.fromEntries(
      Object.entries(result.type).map(([operator, value]) => [
        operator,
        Array.isArray(value) ? value.map(typeOf) : typeOf(value),
      ]),
    );
  }
  // The old prototype's minimum-rating select used a string eq; numeric eq is exact.
  if (
    record(result.rating) &&
    typeof result.rating.eq === "string" &&
    /^[0-5]$/.test(result.rating.eq)
  ) {
    const { eq, ...rest } = result.rating;
    result.rating = { ...rest, gte: Number(eq) };
  }
  for (const field of arrayFields) {
    if (Array.isArray(result[field]))
      result[field] = { all: unique(result[field]) };
  }
  if (Array.isArray(result.or))
    result.or = result.or.map((branch) => normalizeFilter(branch, options));
  return result;
}

export function normalizeSearchQuery(query = {}, options = {}) {
  const value = record(query) ? query : {};
  return {
    ...value,
    version: 1,
    text: string(value.text).slice(0, 500),
    mode: value.mode === "smart" ? "smart" : "text",
    filter: normalizeFilter(value.filter, options),
    grouping: value.grouping || "all",
    view: value.view || "photos",
  };
}

function idsFor(asset, field, options) {
  const fallback =
    field === "personIds" ? asset.people : field === "tagIds" ? asset.tags : [];
  const values = Array.isArray(asset[field])
    ? asset[field]
    : Array.isArray(fallback)
      ? fallback
      : [];
  const items =
    field === "personIds"
      ? options.people
      : field === "tagIds"
        ? options.tags
        : [];
  return unique(
    values
      .map((value) =>
        typeof value === "string" ? idFor(items, value) : value?.id,
      )
      .filter((value) => typeof value === "string"),
  );
}

function fieldValue(asset, field, options) {
  if (arrayFields.has(field)) return idsFor(asset, field, options);
  if (field === "type") return typeOf(asset.type);
  if (field === "takenAt") return asset.takenAt ?? asset.date ?? null;
  if (field === "rating")
    return Object.hasOwn(options.ratings || {}, asset.id)
      ? options.ratings[asset.id]
      : (asset.rating ?? null);
  if (field === "isFavorite") return !!(asset.isFavorite ?? asset.favorite);
  if (field === "visibility")
    return (
      asset.visibility ??
      (asset.isArchived || asset.archived ? "archive" : "timeline")
    );
  if (field === "hasPeople")
    return idsFor(asset, "personIds", options).length > 0;
  if (field === "hasAlbums")
    return idsFor(asset, "albumIds", options).length > 0;
  if (field === "hasTags") return idsFor(asset, "tagIds", options).length > 0;
  if (field === "descriptionStatus") return descriptionStatus(asset);
  if (field === "sensitiveStatus") return sensitiveStatus(asset);
  if (field === "originalFileName")
    return asset.originalFileName ?? asset.name ?? "";
  if (["make", "model", "lensModel"].includes(field))
    return asset[field] ?? asset.exifInfo?.[field] ?? null;
  if (field === "ocr")
    return Array.isArray(asset.ocr)
      ? asset.ocr
          .map((item) => (typeof item === "string" ? item : item?.text || ""))
          .join(" ")
      : (asset.ocr ?? "");
  return asset[field] ?? null;
}

function dateValue(value, endOfDay = false) {
  if (typeof value !== "string") return NaN;
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return Date.parse(value);
  const [, year, month, day] = match.map(Number);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return NaN;
  return time + (endOfDay ? 86_400_000 - 1 : 0);
}

const equal = (left, right) =>
  left === null || right === null
    ? left === right
    : typeof left === "string" && typeof right === "string"
      ? fold(left) === fold(right)
      : left === right;
function like(value, pattern) {
  if (typeof pattern !== "string" || pattern.length > 4096) return false;
  const expression = [...fold(pattern)]
    .map((character) =>
      character === "%" ? ".*" : character === "_" ? "." : escape(character),
    )
    .join("");
  return new RegExp(`^${expression}$`, "u").test(fold(value));
}

function conditionMatches(value, condition, field) {
  if (!record(condition) || !Object.keys(condition).length) return false;
  return Object.entries(condition).every(([operator, expected]) => {
    if (arrayFields.has(field)) {
      if (
        !Array.isArray(expected) ||
        !expected.length ||
        !expected.every((item) => typeof item === "string")
      )
        return false;
      if (operator === "any")
        return expected.some((item) => value.includes(item));
      if (operator === "all")
        return expected.every((item) => value.includes(item));
      if (operator === "none")
        return expected.every((item) => !value.includes(item));
      return false;
    }
    if (booleanFields.has(field))
      return (
        operator === "eq" && typeof expected === "boolean" && value === expected
      );
    if (dateFields.has(field)) {
      const actual = dateValue(value);
      const from = dateValue(expected),
        to = dateValue(expected, true);
      if (![actual, from, to].every(Number.isFinite)) return false;
      if (operator === "eq") return actual >= from && actual <= to;
      if (operator === "ne") return actual < from || actual > to;
      if (operator === "gte") return actual >= from;
      if (operator === "gt") return actual > to;
      if (operator === "lte") return actual <= to;
      if (operator === "lt") return actual < from;
      return false;
    }
    if (operator === "in" || operator === "notIn") {
      if (
        !Array.isArray(expected) ||
        !expected.length ||
        !expected.every((item) =>
          field === "rating"
            ? typeof item === "number" && Number.isFinite(item)
            : typeof item === "string",
        )
      )
        return false;
      const found = expected.some((item) => equal(value, item));
      return operator === "in" ? found : !found;
    }
    if (
      expected !== null &&
      (field === "rating"
        ? typeof expected !== "number" || !Number.isFinite(expected)
        : typeof expected !== "string")
    )
      return false;
    if (operator === "eq") return equal(value, expected);
    if (operator === "ne") return !equal(value, expected);
    if (["lt", "lte", "gt", "gte"].includes(operator)) {
      if (
        typeof value !== "number" ||
        typeof expected !== "number" ||
        !Number.isFinite(expected) ||
        !Number.isFinite(value)
      )
        return false;
      return operator === "lt"
        ? value < expected
        : operator === "lte"
          ? value <= expected
          : operator === "gt"
            ? value > expected
            : value >= expected;
    }
    if (typeof expected !== "string") return false;
    if (operator === "like") return like(value, expected);
    if (operator === "notLike") return !like(value, expected);
    if (operator === "startsWith")
      return fold(value).startsWith(fold(expected));
    if (operator === "endsWith") return fold(value).endsWith(fold(expected));
    if (operator === "matches") return textMatches(string(value), expected);
    return false;
  });
}

function filterMatches(asset, filter, options, depth = 0) {
  if (!record(filter) || depth > 4) return false;
  return Object.entries(filter).every(([field, condition]) => {
    if (field === "or")
      return (
        Array.isArray(condition) &&
        condition.length > 0 &&
        condition.some((branch) =>
          filterMatches(asset, branch, options, depth + 1),
        )
      );
    if (!knownFields.has(field)) return false;
    return conditionMatches(
      fieldValue(asset, field, options),
      condition,
      field,
    );
  });
}

const semanticStopWords = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "at",
  "on",
  "with",
  "and",
  "to",
  "show",
  "me",
  "find",
]);
function textMatches(haystack, text, semantic = false) {
  const normalized = fold(haystack);
  const tokens = [...string(text).matchAll(/(-?)(?:"([^"]+)"|(\S+))/g)]
    .map((match) => ({
      negative: match[1] === "-",
      value: fold(match[2] || match[3]),
    }))
    .filter(
      (token) =>
        token.value &&
        (!semantic || token.negative || !semanticStopWords.has(token.value)),
    );
  return tokens.every((token) =>
    token.negative
      ? !normalized.includes(token.value)
      : normalized.includes(token.value),
  );
}

function textFor(asset, mode, options) {
  if (mode === "filename")
    return fieldValue(asset, "originalFileName", options);
  if (mode === "description") return string(asset.description);
  if (mode === "ocr") return fieldValue(asset, "ocr", options);
  if (mode === "fullPath") return string(asset.originalPath);
  const labels = [
    string(asset.description),
    typeOf(asset.type) === "IMAGE"
      ? "photo image"
      : typeOf(asset.type) === "VIDEO"
        ? "video clip"
        : "",
    ...idsFor(asset, "personIds", options).map((id) =>
      labelFor(options.people, id),
    ),
    ...idsFor(asset, "tagIds", options).map((id) => labelFor(options.tags, id)),
    ...(Array.isArray(asset.keywords) ? asset.keywords : []),
    asset.city,
    asset.state,
    asset.country,
  ];
  if (mode !== "semantic")
    labels.push(
      fieldValue(asset, "originalFileName", options),
      asset.originalPath,
      fieldValue(asset, "ocr", options),
      fieldValue(asset, "make", options),
      fieldValue(asset, "model", options),
      fieldValue(asset, "lensModel", options),
    );
  return labels.filter((value) => typeof value === "string").join(" ");
}

/** Caller supplies already-scoped assets; this helper never imports a global library. */
export function searchSampleAssets(scopedAssets, query = {}, options = {}) {
  const normalized = normalizeSearchQuery(query, options);
  const mode =
    options.textMode || (normalized.mode === "smart" ? "semantic" : "text");
  return scopedAssets.filter(
    (asset) =>
      filterMatches(asset, normalized.filter, options) &&
      textMatches(
        textFor(asset, mode, options),
        normalized.text,
        mode === "semantic",
      ),
  );
}

const facetFields = [
  "personIds",
  "type",
  "city",
  "state",
  "country",
  "make",
  "model",
  "lensModel",
  "rating",
  "tagIds",
  "albumIds",
  "visibility",
  "isFavorite",
  "hasPeople",
  "hasAlbums",
  "hasTags",
  "descriptionStatus",
  "sensitiveStatus",
];
const fieldNames = {
  personIds: "People",
  tagIds: "Tags",
  albumIds: "Albums",
  type: "Media",
  takenAt: "Taken",
  city: "City",
  state: "State / province",
  country: "Country",
  make: "Camera make",
  model: "Camera model",
  lensModel: "Lens",
  rating: "Rating",
  originalFileName: "Filename",
  description: "Description",
  ocr: "OCR text",
  originalPath: "Full path",
  visibility: "Visibility",
  descriptionStatus: "Description",
  sensitiveStatus: "Sensitivity",
};
export const statusLabels = {
  descriptionStatus: {
    generated: "Generated",
    manual: "Written manually",
    missing: "No description",
    failed: "Generation failed",
  },
  sensitiveStatus: {
    reviewed: "Reviewed",
    "needs-review": "Needs review",
    overridden: "Overridden",
  },
};
function valueLabel(field, value, options) {
  if (field === "personIds") return labelFor(options.people, value);
  if (field === "tagIds") return labelFor(options.tags, value);
  if (field === "type")
    return value === "IMAGE"
      ? "Photos"
      : value === "VIDEO"
        ? "Videos"
        : String(value);
  if (field === "visibility")
    return value === "archive"
      ? "Archived"
      : value === "timeline"
        ? "In timeline"
        : String(value);
  if (field === "rating")
    return value === null || value === "null" ? "Unrated" : `${value} stars`;
  if (booleanFields.has(field)) {
    const labels = {
      isFavorite: ["Not favorites", "Favorites"],
      hasPeople: ["No people", "With people"],
      hasAlbums: ["Not in an album", "In an album"],
      hasTags: ["Untagged", "Tagged"],
    };
    return labels[field][value === true || value === "true" ? 1 : 0];
  }
  if (statusFields[field])
    return statusLabels[field][value] || (value === null ? "Not set" : String(value));
  return value === null ? "Not set" : String(value);
}

function withoutFacet(filter, field) {
  return Object.fromEntries(
    Object.entries(filter)
      .filter(([key]) => key !== field)
      .map(([key, value]) => [
        key,
        key === "or" && Array.isArray(value)
          ? value.map((branch) =>
              record(branch) ? withoutFacet(branch, field) : branch,
            )
          : value,
      ]),
  );
}
function selectedValues(filter, field) {
  const condition = filter[field];
  const values = record(condition)
    ? Object.values(condition).flatMap((value) =>
        Array.isArray(value) ? value : [value],
      )
    : [];
  if (Array.isArray(filter.or))
    values.push(
      ...filter.or.flatMap((branch) =>
        record(branch) ? selectedValues(branch, field) : [],
      ),
    );
  return unique(
    values
      .filter(
        (value) =>
          value === null ||
          ["string", "number", "boolean"].includes(typeof value),
      )
      .map(String),
  );
}

/** Counts exclude their own field. All other filters and free text remain active. */
export function sampleFacets(scopedAssets, query = {}, options = {}) {
  const normalized = normalizeSearchQuery(query, options);
  return Object.fromEntries(
    facetFields.map((field) => {
      const matches = searchSampleAssets(
        scopedAssets,
        { ...normalized, filter: withoutFacet(normalized.filter, field) },
        options,
      );
      const counts = new Map();
      for (const asset of matches) {
        const value = fieldValue(asset, field, options);
        for (const item of unique(Array.isArray(value) ? value : [value])) {
          if (
            item === undefined ||
            item === "" ||
            (item === null && field !== "rating")
          )
            continue;
          const key = String(item);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      const selected = selectedValues(normalized.filter, field);
      for (const value of selected)
        if (!counts.has(value)) counts.set(value, 0);
      // Boolean choices are fixed schema values, including a useful zero-match choice.
      if (booleanFields.has(field))
        for (const value of ["true", "false"])
          if (!counts.has(value)) counts.set(value, 0);
      if (statusFields[field])
        for (const value of statusFields[field])
          if (!counts.has(value)) counts.set(value, 0);
      const values = [...counts].map(([value, count]) => ({
        value,
        label: valueLabel(field, value, options),
        count,
        selected: selected.includes(value),
      }));
      values.sort(
        (a, b) =>
          Number(b.selected) - Number(a.selected) ||
          (field === "rating"
            ? Number(b.value) - Number(a.value)
            : statusFields[field]
              ? statusFields[field].indexOf(a.value) -
                statusFields[field].indexOf(b.value)
              : a.label.localeCompare(b.label, undefined, { numeric: true })),
      );
      return [field, values];
    }),
  );
}

const dateLabel = (value) => {
  const time = dateValue(value);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat("en", {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(time)
    : String(value);
};
export function searchChips(query = {}, options = {}) {
  const normalized = normalizeSearchQuery(query, options);
  return Object.entries(normalized.filter).map(([field, condition]) => {
    if (field === "or")
      return {
        field,
        label: `Any of ${Array.isArray(condition) ? condition.length : 0} filter groups`,
      };
    if (!record(condition))
      return { field, label: `${fieldNames[field] || field}: invalid filter` };
    if (booleanFields.has(field))
      return { field, label: valueLabel(field, condition.eq, options) };
    const parts = Object.entries(condition).map(([operator, value]) => {
      const label = (item) =>
        dateFields.has(field)
          ? dateLabel(item)
          : valueLabel(field, item, options);
      const formatted = Array.isArray(value)
        ? value.map(label).join(operator === "all" ? " and " : " or ")
        : label(value);
      if (
        operator === "eq" ||
        operator === "any" ||
        operator === "all" ||
        operator === "in"
      )
        return formatted;
      if (operator === "none") return `without ${formatted}`;
      if (["ne", "notIn", "notLike"].includes(operator))
        return `not ${formatted}`;
      if (operator === "gte")
        return field === "rating"
          ? `${formatted} or more`
          : `from ${formatted}`;
      if (operator === "gt") return `after ${formatted}`;
      if (operator === "lte") return `through ${formatted}`;
      if (operator === "lt") return `before ${formatted}`;
      if (operator === "startsWith") return `starts with ${formatted}`;
      if (operator === "endsWith") return `ends with ${formatted}`;
      return formatted.replace(/^%|%$/g, "");
    });
    return {
      field,
      label: `${fieldNames[field] || field}: ${parts.join("; ")}`,
    };
  });
}

function placeEntries(places) {
  const result = [];
  for (const place of Array.isArray(places) ? places : []) {
    if (typeof place === "string") result.push({ field: "city", value: place });
    else if (record(place)) {
      if (
        ["city", "state", "country"].includes(place.field) &&
        typeof place.value === "string"
      )
        result.push(place);
      else
        for (const field of ["city", "state", "country"])
          if (typeof place[field] === "string")
            result.push({ field, value: place[field] });
    }
  }
  return [
    ...new Map(
      result.map((item) => [`${item.field}:${fold(item.value)}`, item]),
    ).values(),
  ];
}

/** Deterministic sample vocabulary and UTC calendar rules, not an AI interpretation. */
export function resolveSamplePhrase(text, options = {}) {
  const input = string(text).slice(0, 500);
  const filter = {},
    spans = [],
    recognized = [];
  const free = (start, end) =>
    !spans.some((span) => start < span.end && end > span.start);
  const take = (field, start, end, value) => {
    if (!free(start, end)) return false;
    spans.push({ start, end });
    recognized.push({ field, phrase: input.slice(start, end), value });
    return true;
  };
  const negativePrefix = (start) =>
    input.slice(0, start).match(/\b(?:without|not|no|excluding)\s+$/i);
  const scanName = (name, callback) => {
    if (!name) return;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    for (const match of input.matchAll(pattern)) callback(match);
  };
  const positives = [],
    negatives = [],
    peopleMatches = [];
  for (const person of [...catalog(options.people)].sort(
    (a, b) => (b.name || b.id).length - (a.name || a.id).length,
  )) {
    scanName(person.name || person.id, (match) => {
      const prefix = negativePrefix(match.index);
      const start = match.index - (prefix?.[0].length || 0);
      if (take("personIds", start, match.index + match[0].length)) {
        (prefix ? negatives : positives).push(person.id);
        if (!prefix)
          peopleMatches.push({
            start: match.index,
            end: match.index + match[0].length,
          });
      }
    });
  }
  if (positives.length || negatives.length) {
    peopleMatches.sort((a, b) => a.start - b.start);
    const any = peopleMatches.some(
      (item, index) =>
        index > 0 &&
        /\bor\b/i.test(input.slice(peopleMatches[index - 1].end, item.start)),
    );
    filter.personIds = {
      ...(positives.length ? { [any ? "any" : "all"]: unique(positives) } : {}),
      ...(negatives.length ? { none: unique(negatives) } : {}),
    };
  }
  const types = [],
    excludedTypes = [];
  for (const match of input.matchAll(
    /\b(photos?|pictures?|images?|videos?|clips?|movies?)\b/gi,
  )) {
    const prefix = negativePrefix(match.index),
      start = match.index - (prefix?.[0].length || 0);
    if (take("type", start, match.index + match[0].length))
      (prefix ? excludedTypes : types).push(
        /video|clip|movie/i.test(match[0]) ? "VIDEO" : "IMAGE",
      );
  }
  if (types.length || excludedTypes.length)
    filter.type = {
      ...(types.length
        ? unique(types).length === 1
          ? { eq: types[0] }
          : { in: unique(types) }
        : {}),
      ...(excludedTypes.length
        ? unique(excludedTypes).length === 1
          ? { ne: excludedTypes[0] }
          : { notIn: unique(excludedTypes) }
        : {}),
    };
  for (const match of input.matchAll(
    /\b(no people|without people|with people)\b/gi,
  )) {
    if (take("hasPeople", match.index, match.index + match[0].length))
      filter.hasPeople = { eq: /^with people$/i.test(match[0]) };
  }
  const places = new Map();
  for (const place of placeEntries(options.places).sort(
    (a, b) => b.value.length - a.value.length,
  )) {
    scanName(place.value, (match) => {
      const prefix = negativePrefix(match.index),
        start = match.index - (prefix?.[0].length || 0);
      if (!take(place.field, start, match.index + match[0].length)) return;
      const values = places.get(place.field) || { positive: [], negative: [] };
      values[prefix ? "negative" : "positive"].push(place.value);
      places.set(place.field, values);
    });
  }
  for (const [field, values] of places)
    filter[field] = {
      ...(values.positive.length
        ? unique(values.positive).length === 1
          ? { eq: values.positive[0] }
          : { in: unique(values.positive) }
        : {}),
      ...(values.negative.length
        ? unique(values.negative).length === 1
          ? { ne: values.negative[0] }
          : { notIn: unique(values.negative) }
        : {}),
    };
  const now = new Date(options.now ?? Date.now());
  const reference = Number.isFinite(now.getTime())
    ? now
    : new Date("2026-01-01T00:00:00Z");
  const range = (start, end) => ({
    gte: new Date(start).toISOString(),
    lt: new Date(end).toISOString(),
  });
  const acceptDate = (match, condition) => {
    if (
      !filter.takenAt &&
      take("takenAt", match.index, match.index + match[0].length)
    )
      filter.takenAt = condition;
  };
  for (const match of input.matchAll(
    /\b(?:from|between)\s+(\d{4}-\d{2}-\d{2})\s+(?:to|through|and)\s+(\d{4}-\d{2}-\d{2})\b/gi,
  )) {
    const start = dateValue(match[1]),
      end = dateValue(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end)
      acceptDate(match, range(start, end + 86_400_000));
  }
  for (const match of input.matchAll(
    /\b(on|before|after)\s+(\d{4}-\d{2}-\d{2})\b/gi,
  )) {
    const day = dateValue(match[2]);
    if (!Number.isFinite(day)) continue;
    const operator = fold(match[1]);
    acceptDate(
      match,
      operator === "on"
        ? range(day, day + 86_400_000)
        : operator === "before"
          ? { lt: new Date(day).toISOString() }
          : { gte: new Date(day + 86_400_000).toISOString() },
    );
  }
  for (const match of input.matchAll(
    /\b(today|yesterday|this year|last year|this month|last month)\b/gi,
  )) {
    const phrase = fold(match[0]);
    let start, end;
    const year = reference.getUTCFullYear(),
      month = reference.getUTCMonth(),
      day = reference.getUTCDate();
    if (phrase.includes("year")) {
      start = Date.UTC(year - (phrase === "last year" ? 1 : 0), 0, 1);
      end = Date.UTC(new Date(start).getUTCFullYear() + 1, 0, 1);
    } else if (phrase.includes("month")) {
      const selected = month - (phrase === "last month" ? 1 : 0);
      start = Date.UTC(year, selected, 1);
      end = Date.UTC(year, selected + 1, 1);
    } else {
      start = Date.UTC(year, month, day - (phrase === "yesterday" ? 1 : 0));
      end = start + 86_400_000;
    }
    acceptDate(match, range(start, end));
  }
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const monthPattern = new RegExp(
    `\\b(${months.join("|")})\\s+(20\\d{2})\\b`,
    "gi",
  );
  for (const match of input.matchAll(monthPattern)) {
    const month = months.indexOf(fold(match[1]));
    acceptDate(
      match,
      range(
        Date.UTC(Number(match[2]), month, 1),
        Date.UTC(Number(match[2]), month + 1, 1),
      ),
    );
  }
  const relativeMonthPattern = new RegExp(
    `\\bin\\s+(${months.join("|")})\\b`,
    "gi",
  );
  for (const match of input.matchAll(relativeMonthPattern)) {
    const month = months.indexOf(fold(match[1]));
    acceptDate(
      match,
      range(
        Date.UTC(reference.getUTCFullYear(), month, 1),
        Date.UTC(reference.getUTCFullYear(), month + 1, 1),
      ),
    );
  }
  for (const match of input.matchAll(/\b(?:in|during|from)?\s*(20\d{2})\b/gi)) {
    if (
      /[\d-]/.test(input[match.index + match[0].length] || "") ||
      /[\d-]/.test(input[match.index - 1] || "")
    )
      continue;
    acceptDate(
      match,
      range(
        Date.UTC(Number(match[1]), 0, 1),
        Date.UTC(Number(match[1]) + 1, 0, 1),
      ),
    );
  }
  const characters = input.split("");
  for (const span of spans)
    for (let i = span.start; i < span.end; i++) characters[i] = " ";
  let remainder = characters.join("").replace(/\s+/g, " ").trim();
  if (recognized.length)
    remainder = remainder
      .replace(
        /\b(show|me|find|all|my|of|with|in|at|from|during|and|or|to|the|a|an|please)\b/gi,
        " ",
      )
      .replace(/^[\s,;]+|[\s,;]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const query = normalizeSearchQuery({ text: remainder, filter });
  return {
    query,
    recognized: recognized.map((item) => ({
      ...item,
      value: clone(filter[item.field]),
    })),
    explanation: recognized.length
      ? "Matched explicit sample names, places, media words and UTC calendar phrases. Remaining words search sample metadata; no AI or server request was used."
      : "No known sample phrase was resolved. The original text remains available for local metadata matching.",
  };
}

/**
 * Slice a result list for "Load more" style paging. `items` is the requested
 * page; `visible` is everything through that page. Out-of-range pages clamp.
 */
export function paginate(items, page = 1, pageSize = 60) {
  const list = Array.isArray(items) ? items : [];
  const size =
    Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 1000) : 60;
  const pageCount = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(
    Math.max(1, Number.isInteger(page) ? page : 1),
    pageCount,
  );
  const start = (current - 1) * size;
  const end = Math.min(list.length, current * size);
  return {
    items: list.slice(start, end),
    visible: list.slice(0, end),
    page: current,
    pageSize: size,
    pageCount,
    total: list.length,
    start: list.length ? start + 1 : 0,
    end,
    hasMore: end < list.length,
    remaining: list.length - end,
  };
}

/** Human summary for a paginate() result. Cumulative wording suits "Load more". */
export function pageSummary(pagination, options = {}) {
  const noun = string(options.noun) || "items";
  const singular = string(options.singular) || noun.replace(/s$/, "");
  const total = Number.isInteger(pagination?.total) ? pagination.total : 0;
  if (!total) return `No ${noun}`;
  const name = total === 1 ? singular : noun;
  const count = (value) => value.toLocaleString("en");
  if (pagination.end >= total) return `Showing all ${count(total)} ${name}`;
  if (options.cumulative)
    return `Showing ${count(pagination.end)} of ${count(total)} ${name}`;
  return `Showing ${count(pagination.start)}–${count(pagination.end)} of ${count(total)} ${name}`;
}
