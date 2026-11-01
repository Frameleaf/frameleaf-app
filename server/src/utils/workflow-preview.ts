/**
 * FL-729: the built-in filters of `immich-plugin-core`, evaluated by the server for "Check and
 * preview" so the count and examples are what a run would keep. These read only the asset, so the
 * preview stays a dry run: no plugin is called and nothing is changed.
 *
 * Each one mirrors the method of the same name in `packages/plugin-core/src/index.ts`. Change both
 * together; `workflow-preview.spec.ts` pins the shared behaviour. Plugins run under QuickJS in UTC,
 * so dates here are built in UTC too.
 */

type PreviewExif = Record<string, unknown> & {
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  timeZone?: string | null;
};

export type PreviewAsset = {
  id: string;
  type: string;
  localDateTime: Date | string;
  originalPath: string;
  originalFileName: string;
  tags: { id: string }[];
  exifInfo: PreviewExif | null;
};

type Config = Record<string, any>;
type DateParts = { year: number; month: number; day: number };

const matchValue = (value: string, config: Config) => {
  const { pattern, matchType = 'contains', caseSensitive = false } = config;
  if (matchType === 'regex') {
    if (typeof value !== 'string' || typeof pattern !== 'string') {
      throw new TypeError('Regular-expression inputs must be strings');
    }
    return new RegExp(pattern, caseSensitive ? '' : 'i').test(value);
  }
  const name = caseSensitive ? value : value.toLowerCase();
  const search = caseSensitive ? pattern : pattern.toLowerCase();
  switch (matchType) {
    case 'contains': {
      return name.includes(search);
    }
    case 'exact': {
      return name === search;
    }
    case 'startsWith': {
      return name.startsWith(search);
    }
    default: {
      // the plugin returns no decision, and a run continues
      return true;
    }
  }
};

const utc = ({ year, month, day }: DateParts, extraDays = 0) => new Date(Date.UTC(year, month - 1, day + extraDays));

const filters: Record<string, (config: Config, asset: PreviewAsset) => boolean> = {
  assetTypeFilter: (config, asset) => (config.allowedTypes ?? []).includes(asset.type),

  assetFileFilter: (config, asset) => matchValue(config.usePath ? asset.originalPath : asset.originalFileName, config),

  assetExifFilter: (config, asset) => {
    if (!asset.exifInfo || asset.exifInfo[config.property] === null) {
      return false;
    }
    return matchValue(String(asset.exifInfo[config.property]), config);
  },

  assetTagFilter: (config, asset) => {
    const tags = new Set(asset.tags.map((tag) => tag.id));
    const wanted: string[] = config.tags ?? [];
    switch (config.matching) {
      case 'any': {
        return wanted.some((tag) => tags.has(tag));
      }
      case 'all': {
        return wanted.every((tag) => tags.has(tag));
      }
      case 'none': {
        return wanted.every((tag) => !tags.has(tag));
      }
      default: {
        return true;
      }
    }
  },

  assetMissingTimeZoneFilter: (config, asset) => !!asset.exifInfo?.timeZone === !!config.inverse,

  assetDateFilter: (config, asset) => {
    const assetDate = new Date(asset.localDateTime);
    const startDate = utc(config.startDate);
    const endDate = utc(config.endDate, 1);
    if (config.recurring) {
      startDate.setUTCFullYear(assetDate.getUTCFullYear());
      endDate.setUTCFullYear(assetDate.getUTCFullYear());
      if (endDate < startDate) {
        if (assetDate > endDate) {
          endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
        } else {
          startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
        }
      }
    }
    return assetDate >= startDate && assetDate < endDate;
  },

  assetLocationFilter: (config, asset) => {
    const exif = asset.exifInfo;
    if (
      (config.region?.country && config.region.country !== exif?.country) ||
      (config.region?.state && config.region.state !== exif?.state) ||
      (config.region?.city && config.region.city !== exif?.city)
    ) {
      return false;
    }
    const configLat = config.coordinate?.latitude;
    const configLon = config.coordinate?.longitude;
    if (configLat === undefined || configLon === undefined) {
      return true;
    }
    const assetLat = exif?.latitude;
    const assetLon = exif?.longitude;
    if (assetLat === undefined || assetLat === null || assetLon === undefined || assetLon === null) {
      return false;
    }
    const deg = Math.PI / 180;
    const delta = Math.asin(
      Math.sqrt(
        Math.pow(Math.sin((assetLat * deg - configLat * deg) / 2), 2) +
          Math.cos(assetLat * deg) *
            Math.cos(configLat * deg) *
            Math.pow(Math.sin((assetLon * deg - configLon * deg) / 2), 2),
      ),
    );
    return 12_742 * delta <= (config.coordinate?.radius ?? 0);
  },
};

const CORE_PLUGIN = 'immich-plugin-core#';

const coreName = (method: string) => (method.startsWith(CORE_PLUGIN) ? method.slice(CORE_PLUGIN.length) : undefined);

/**
 * The read-only check for a built-in filter step, or none when the step can only be known by running it.
 * A regular-expression match is left to the run: a run evaluates it inside the plugin sandbox, and the
 * server must not run an owner's pattern over thousands of assets on its own event loop (ReDoS).
 */
export const getPreviewFilter = (method: string, config?: Config | null) => {
  const name = coreName(method);
  return name && config?.matchType !== 'regex' ? filters[name] : undefined;
};

/** Whether a step is one of the built-in plugin's actions, which a preview never runs. */
export const isCoreAction = (method: string) => {
  const name = coreName(method);
  return !!name && !Object.hasOwn(filters, name);
};

/** Whether the asset gets past this filter in a run. A filter that throws fails the run there, so the asset stops. */
export const passesPreviewFilter = (
  filter: (config: Config, asset: PreviewAsset) => boolean,
  config: Config | null | undefined,
  asset: PreviewAsset,
) => {
  try {
    return filter(config ?? {}, asset);
  } catch {
    return false;
  }
};
