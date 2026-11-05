/**
 * Library magic (approved design, 2026-11-04, `settings-v2/overnight/analytics/Dashboard.jsx`): what the
 * panels say about the numbers the server worked out. Colour names and the forecast are worked out here.
 */
import type { AnalyticsBucketDto, AnalyticsHostDto, AnalyticsSummaryDto } from '@frameleaf/sdk';

export type ColourName =
  'red' | 'orange' | 'brown' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'grey' | 'white' | 'black';

/** The everyday name of a `#rrggbb` colour, from its hue, saturation and lightness. */
export function colourName(hex: string): ColourName {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (lightness < 0.12) {
    return 'black';
  }
  if (lightness > 0.9) {
    return 'white';
  }
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.15) {
    return 'grey';
  }
  let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) {
    return 'red';
  }
  if (hue < 45) {
    return lightness < 0.45 ? 'brown' : 'orange';
  }
  if (hue < 70) {
    return lightness < 0.35 ? 'brown' : 'yellow';
  }
  if (hue < 160) {
    return 'green';
  }
  if (hue < 195) {
    return 'teal';
  }
  if (hue < 255) {
    return 'blue';
  }
  if (hue < 300) {
    return 'purple';
  }
  return 'pink';
}

const DAY = 86_400_000;
const MONTH_DAYS = 30.44;

export type Forecast = {
  perMonth: number;
  milestone: number;
  milestoneOn: Date;
  bytesPerMonth: number;
  /** When the drive would be full at this pace; null when that is more than 50 years off or unknown. */
  fullOn: Date | null;
};

/** The next round number of items above `items`: 1,000, 2,000… 10,000, 20,000… */
export const nextMilestone = (items: number) => {
  const step = 10 ** Math.max(3, Math.floor(Math.log10(Math.max(1, items))));
  return (Math.floor(items / step) + 1) * step;
};

/**
 * Where the library is heading at the pace of the selected dates: photos and videos added per month,
 * when it reaches its next milestone, and when the drive fills. A forecast, not a promise; null when
 * nothing was added in the selected dates.
 * ponytail: a straight line from the average pace; seasonal shooting makes it wobble.
 */
export function forecast(
  series: AnalyticsBucketDto[],
  summary: AnalyticsSummaryDto,
  host: AnalyticsHostDto,
  now = new Date(),
): Forecast | null {
  if (series.length === 0) {
    return null;
  }
  const added = series.reduce((sum, bucket) => sum + bucket.photos + bucket.videos, 0);
  const days = Math.max(1, (Date.parse(series.at(-1)!.through) - Date.parse(series[0].from)) / DAY + 1);
  const perDay = added / days;
  if (added === 0 || perDay <= 0) {
    return null;
  }
  const milestone = nextMilestone(summary.items);
  const bytesPerItem = summary.items > 0 ? summary.physicalBytes / summary.items : 0;
  const bytesPerDay = perDay * bytesPerItem;
  const fullInDays = host.freeBytes !== null && bytesPerDay > 0 ? host.freeBytes / bytesPerDay : null;
  return {
    perMonth: Math.round(perDay * MONTH_DAYS),
    milestone,
    milestoneOn: new Date(now.getTime() + ((milestone - summary.items) / perDay) * DAY),
    bytesPerMonth: bytesPerDay * MONTH_DAYS,
    fullOn: fullInDays !== null && fullInDays < 365 * 50 ? new Date(now.getTime() + fullInDays * DAY) : null,
  };
}

/** Whole laps of the Earth's equator (40,075 km) in `km`, to one decimal. */
export const laps = (km: number) => Math.round((km / 40_075) * 10) / 10;
