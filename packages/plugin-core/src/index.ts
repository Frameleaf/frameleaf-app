import { wrapper } from '@frameleaf/plugin-sdk';
import { AssetVisibility } from '@frameleaf/sdk';
import type { Manifest } from '../dist/index.d.ts';

type MatchValueConfig = {
  pattern: string;
  matchType?: 'contains' | 'exact' | 'regex' | 'startsWith';
  caseSensitive?: boolean;
};

// Only the plugin methods may be exported from this module: the Extism JS runtime resolves a call
// by the position of the export, so any other export shifts every method onto its neighbour.

/** The longest regular expression a filter takes; file names and EXIF values need nothing near it. */
const MAX_REGEX_PATTERN_LENGTH = 256;

/** `{n}`, `{n,}` or `{n,m}` at `index`: a counted quantifier (anything else there is a literal brace). */
const countedQuantifierAt = (pattern: string, index: number) => /^\{\d+(?:,\d*)?\}/.test(pattern.slice(index));

/** The text an alternative matches when it is plain literal characters, or `undefined` when it is not. */
const literalAlternative = (alternative: string, caseInsensitive: boolean): string | undefined => {
  let text = '';
  for (let index = 0; index < alternative.length; index++) {
    const char = alternative[index];
    if (char === '\\') {
      const escaped = alternative[index + 1];
      // `\d`, `\w`, `\b`, `\1`, `\x41` and the like are classes, anchors or codes, not one fixed character.
      if (escaped === undefined || /[\dA-Za-z]/.test(escaped)) {
        return undefined;
      }
      text += escaped;
      index++;
    } else if ('.[](){}*+?^$|'.includes(char)) {
      return undefined;
    } else {
      text += char;
    }
  }
  return caseInsensitive ? text.toLowerCase() : text;
};

/**
 * Whether a group's alternatives can match the same text in more than one way, as in `(a|a)`, `(a|aa)`
 * or `(a|)`. Alternatives of plain literal text where none starts with another, such as `(jpg|png)` or
 * `(jpg|jpeg)`, split any input in at most one way, so repeating them stays linear. Any other group
 * with a `|` counts as ambiguous, which only matters when the group is repeated.
 */
const ambiguousAlternation = (alternatives: string[], caseInsensitive: boolean): boolean => {
  const literals: string[] = [];
  for (const alternative of alternatives) {
    const text = literalAlternative(alternative, caseInsensitive);
    if (text === undefined) {
      return true;
    }
    literals.push(text);
  }
  return literals.some((text, index) =>
    literals.some((other, otherIndex) => otherIndex !== index && other.startsWith(text)),
  );
};

type GroupScan = {
  quantifierInside: boolean;
  ambiguous: boolean;
  bodyStart: number;
  bars: number[];
  assertion: boolean;
};

const newGroupScan = (bodyStart: number): GroupScan => ({
  quantifierInside: false,
  ambiguous: false,
  bodyStart,
  bars: [],
  assertion: false,
});

/**
 * Why a pattern could backtrack exponentially, or `undefined` when it cannot in these shapes:
 * `quantifier` for a quantified group that holds a quantifier, as in `(a+)+`, `(a*)*`, `(\d?){2,}` or
 * `((a+)b)+`, and `alternation` for a quantified group whose alternatives overlap, as in `(a|a)+$` or
 * `((a|aa)b)*`. Both make a backtracking matcher try an exponential number of ways to split the input.
 * The workflow owner writes the pattern and anyone can upload a file name for it to run against, and
 * the plugin runtime has no backtracking limit, so such patterns are refused up front. Escapes and
 * character classes are skipped; `(?` opens a non-capturing group or an assertion, not a quantifier.
 */
const unboundedBacktracking = (pattern: string, caseInsensitive: boolean): 'quantifier' | 'alternation' | undefined => {
  const enclosing: GroupScan[] = [];
  let current = newGroupScan(0);
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '\\') {
      index++;
    } else if (inClass) {
      inClass = char !== ']';
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(') {
      enclosing.push(current);
      current = newGroupScan(index + 1);
      if (pattern[index + 1] === '?') {
        // `(?:` and `(?<name>` start the alternatives after their opener; lookarounds are never treated as literal.
        const named = /^\?<[A-Za-z_$][\w$]*>/.exec(pattern.slice(index + 1));
        const opener = named ? named[0].length : pattern[index + 2] === ':' ? 2 : 0;
        current.assertion = opener === 0;
        index += opener === 0 ? 1 : opener;
        current.bodyStart = index + 1;
      }
    } else if (char === '|') {
      current.bars.push(index);
    } else if (char === ')') {
      const inner = current;
      current = enclosing.pop() ?? newGroupScan(0);
      const next = pattern[index + 1];
      const quantified = next === '*' || next === '+' || (next === '{' && countedQuantifierAt(pattern, index + 1));
      let ambiguous = inner.ambiguous;
      if (inner.bars.length > 0) {
        const bounds = [inner.bodyStart - 1, ...inner.bars, index];
        const alternatives = bounds.slice(1).map((end, part) => pattern.slice(bounds[part] + 1, end));
        ambiguous ||= inner.assertion || ambiguousAlternation(alternatives, caseInsensitive);
      }
      if (quantified && inner.quantifierInside) {
        return 'quantifier';
      }
      if (quantified && ambiguous) {
        return 'alternation';
      }
      current.quantifierInside ||= inner.quantifierInside || quantified;
      current.ambiguous ||= ambiguous;
    } else if (char === '*' || char === '+' || char === '?' || (char === '{' && countedQuantifierAt(pattern, index))) {
      current.quantifierInside = true;
    }
  }
  return undefined;
};

/** The filter's regular expression, or a RangeError for one that could run for an unbounded time. */
const filterRegExp = (pattern: string, flags: string) => {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new RangeError(`Regular-expression patterns are limited to ${MAX_REGEX_PATTERN_LENGTH} characters`);
  }
  const reason = unboundedBacktracking(pattern, flags.includes('i'));
  if (reason === 'quantifier') {
    throw new RangeError(
      'Regular-expression patterns must not quantify a group that holds a quantifier (such as (a+)+), which can take unbounded time',
    );
  }
  if (reason === 'alternation') {
    throw new RangeError(
      'Regular-expression patterns must not quantify a group whose alternatives overlap (such as (a|a)+), which can take unbounded time',
    );
  }
  return new RegExp(pattern, flags);
};

const matchValueResult = (value: string, config: MatchValueConfig) => {
  const { pattern, matchType = 'contains', caseSensitive = false } = config;
  if (matchType === 'regex') {
    if (typeof value !== 'string' || typeof pattern !== 'string') {
      throw new TypeError('Regular-expression inputs must be strings');
    }
    return { workflow: { continue: filterRegExp(pattern, caseSensitive ? '' : 'i').test(value) } };
  }
  const searchName = caseSensitive ? value : value.toLowerCase();
  const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();

  switch (matchType) {
    case 'contains': {
      return { workflow: { continue: searchName.includes(searchPattern) } };
    }

    case 'exact': {
      return { workflow: { continue: searchName === searchPattern } };
    }

    case 'startsWith': {
      return { workflow: { continue: searchName.startsWith(searchPattern) } };
    }

    default: {
      return {};
    }
  }
};

const methods = wrapper<Manifest>({
  assetAddTags: ({ config, data, functions }) => {
    functions.bulkTagAssets({ assetIds: [data.asset.id], tagIds: config.tags });
    return {};
  },

  assetAddToAlbums: ({ config, data, functions }) => {
    const assetId = data.asset.id;

    if (config.albumIds.length === 0) {
      if (!config.albumName) {
        return {};
      }

      const existing = functions.searchAlbums({ isOwned: true }).find((album) => album.albumName === config.albumName);
      if (!existing) {
        const created = functions.createAlbum({ albumName: config.albumName, assetIds: [assetId] });
        config.albumIds.push(created.id);
        return {};
      }

      config.albumIds.push(existing.id);
    }

    if (config.albumIds.length === 1) {
      functions.addAssetsToAlbum(config.albumIds[0], [assetId]);
      return {};
    }

    functions.addAssetsToAlbums({ albumIds: config.albumIds, assetIds: [assetId] });
    return {};
  },

  assetArchive: ({ config, data }) => {
    if (!config.inverse && data.asset.visibility !== AssetVisibility.Archive) {
      return { changes: { asset: { visibility: AssetVisibility.Archive } } };
    }

    if (config.inverse && data.asset.visibility === AssetVisibility.Archive) {
      return { changes: { asset: { visibility: AssetVisibility.Timeline } } };
    }

    return {};
  },

  assetFavorite: ({ config, data }) => {
    const target = config.inverse ? false : true;
    if (target !== data.asset.isFavorite) {
      return {
        changes: {
          asset: { isFavorite: target },
        },
      };
    }
  },

  assetFileFilter: ({ data, config }) =>
    matchValueResult(config.usePath ? data.asset.originalPath : data.asset.originalFileName, config),

  assetLocationFilter: ({ config, data }) => {
    if (
      (config.region?.country && config.region.country !== data.asset.exifInfo?.country) ||
      (config.region?.state && config.region.state !== data.asset.exifInfo?.state) ||
      (config.region?.city && config.region.city !== data.asset.exifInfo?.city)
    ) {
      return { workflow: { continue: false } };
    }

    const configLat = config.coordinate?.latitude;
    const configLon = config.coordinate?.longitude;

    if (configLat === undefined || configLon === undefined) {
      return { workflow: { continue: true } };
    }

    const assetLat = data.asset.exifInfo?.latitude;
    const assetLon = data.asset.exifInfo?.longitude;

    if (assetLat === undefined || assetLat === null || assetLon === undefined || assetLon === null) {
      return { workflow: { continue: false } };
    }

    const earthDiameter = 12742;
    const deg = Math.PI / 180;
    const delta = Math.asin(
      Math.sqrt(
        Math.pow(Math.sin((assetLat * deg - configLat * deg) / 2), 2) +
          Math.cos(assetLat * deg) *
            Math.cos(configLat * deg) *
            Math.pow(Math.sin((assetLon * deg - configLon * deg) / 2), 2),
      ),
    );

    return { workflow: { continue: earthDiameter * delta <= (config.coordinate?.radius ?? 0) } };
  },

  assetExifFilter: ({ config, data }) => {
    const value = data.asset.exifInfo?.[config.property];
    // A missing field is no value, not the text "undefined" for a pattern to match.
    if (value === null || value === undefined) {
      return { workflow: { continue: false } };
    }

    return matchValueResult(String(value), config);
  },

  assetDateFilter: ({ config, data }) => {
    const assetDate = new Date(data.asset.localDateTime);
    let startDate = new Date(config.startDate.year, config.startDate.month - 1, config.startDate.day);
    let endDate = new Date(config.endDate.year, config.endDate.month - 1, config.endDate.day + 1);

    if (config.recurring) {
      startDate.setFullYear(assetDate.getFullYear());
      endDate.setFullYear(assetDate.getFullYear());

      if (endDate < startDate) {
        if (assetDate > endDate) {
          endDate.setFullYear(endDate.getFullYear() + 1);
        } else {
          startDate.setFullYear(startDate.getFullYear() - 1);
        }
      }
    }

    return { workflow: { continue: assetDate >= startDate && assetDate < endDate } };
  },

  assetLock: ({ config, data }) => {
    if (!config.inverse && data.asset.visibility !== AssetVisibility.Locked) {
      return { changes: { asset: { visibility: AssetVisibility.Locked } } };
    }

    if (config.inverse && data.asset.visibility === AssetVisibility.Locked) {
      return { changes: { asset: { visibility: AssetVisibility.Timeline } } };
    }

    return {};
  },

  assetMissingTimeZoneFilter: ({ config, data }) => {
    const hasTimeZone = !!data.asset?.exifInfo?.timeZone;
    const needsTimeZone = config.inverse ? true : false;
    return { workflow: { continue: hasTimeZone === needsTimeZone } };
  },

  assetTagFilter: ({ config, data }) => {
    const tags = new Set(data.asset.tags.map((tag) => tag.id));
    let continueWorkflow = true;
    switch (config.matching) {
      case 'any': {
        continueWorkflow = config.tags.some((tag) => tags.has(tag));
        break;
      }
      case 'all': {
        continueWorkflow = config.tags.every((tag) => tags.has(tag));
        break;
      }
      case 'none': {
        continueWorkflow = !config.tags.some((tag) => tags.has(tag));
        break;
      }
    }
    return { workflow: { continue: continueWorkflow } };
  },

  assetTypeFilter: ({ config, data }) => {
    return { workflow: { continue: config.allowedTypes.includes(data.asset.type) } };
  },

  assetVisibility: ({ config }) => ({
    changes: { asset: { visibility: config.visibility as AssetVisibility } },
  }),

  webhook: ({ config, data, functions, type, trigger }) => {
    const headers: Record<string, string> = {};

    if (config.headerName && config.headerValue) {
      headers[config.headerName] = config.headerValue;
    }

    headers['Content-Type'] = 'application/json';

    functions.httpRequest(config.url, {
      method: config.method ?? 'POST',
      body: JSON.stringify({
        type,
        trigger,
        data,
      }),
      headers,
      // FL-819: the server signs the message; the secret itself is never sent
      ...(config.secret && { signingSecret: config.secret }),
    });

    return {};
  },
});

const {
  assetAddTags,
  assetAddToAlbums,
  assetArchive,
  assetFavorite,
  assetFileFilter,
  assetLocationFilter,
  assetExifFilter,
  assetDateFilter,
  assetLock,
  assetMissingTimeZoneFilter,
  assetTagFilter,
  assetTypeFilter,
  assetVisibility,
  webhook,

  // should be empty. ensures that every field is destructured
  ...rest
} = methods;

export {
  assetAddTags,
  assetAddToAlbums,
  assetArchive,
  assetFavorite,
  assetFileFilter,
  assetLocationFilter,
  assetExifFilter,
  assetDateFilter,
  assetLock,
  assetMissingTimeZoneFilter,
  assetTagFilter,
  assetTypeFilter,
  assetVisibility,
  webhook,
};

'All methods must be destructured and exported' satisfies string & typeof rest;
