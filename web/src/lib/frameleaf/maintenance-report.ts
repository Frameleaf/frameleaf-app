/**
 * Integrity report viewer adapter for the Frameleaf Maintenance area (FL-81).
 *
 * Production's integrity reports (`IntegrityReport.UntrackedFile`, `MissingFile`,
 * `ChecksumMismatch`) are per-type, paginated by cursor and carry only `{ id, path }`
 * per finding — there is no severity, message or detail field like the design
 * template's simulated `maintenance-data.mjs` findings. This module ports the
 * template's `filterFindings` intent (a bounded, case-insensitive substring filter
 * over whatever text the finding exposes) to that real shape, so the report viewer
 * can filter the page of items it already has without a server round trip.
 *
 * Query length is capped the same way the template caps free text input, so a
 * pasted block of text cannot make every keystroke re-filter a huge array.
 */

export const MAINTENANCE_REPORT_QUERY_MAX_LENGTH = 200;

export interface MaintenanceReportItem {
  id: string;
  path: string;
}

/** Trims and caps a raw search box value the same way the template's `string()` helper does. */
export const normalizeMaintenanceReportQuery = (query: string | undefined | null): string =>
  (query ?? '').trim().slice(0, MAINTENANCE_REPORT_QUERY_MAX_LENGTH).toLowerCase();

/**
 * Filters integrity report items by a case-insensitive substring match on `path`.
 * An empty/whitespace-only query returns every item, matching the template's
 * "no filter selected" behaviour for `filterFindings`.
 */
export const filterMaintenanceReportItems = <T extends MaintenanceReportItem>(
  items: readonly T[],
  query: string | undefined | null,
): T[] => {
  const normalized = normalizeMaintenanceReportQuery(query);
  if (!normalized) {
    return [...items];
  }
  return items.filter((item) => item.path.toLowerCase().includes(normalized));
};

/** Summary text data for "n of m findings" style live regions, without formatting the string itself. */
export const summarizeMaintenanceReportFilter = (
  filtered: number,
  total: number,
): { filtered: number; total: number; isFiltered: boolean } => ({
  filtered,
  total,
  isFiltered: filtered !== total,
});

/**
 * The template's "Download report file" (`Maintenance.jsx:786-794`, `reportToText` and
 * `reportFileName` in `maintenance-data.mjs:657-674`) on production's findings: a heading, when
 * the check last ran and how many findings it has, then one path per line. Production findings
 * carry no severity or message, so those lines are the path alone.
 */
export const maintenanceReportText = ({
  title,
  lastRunAt,
  paths,
}: {
  title: string;
  lastRunAt: string | null | undefined;
  paths: readonly string[];
}): string =>
  [
    `Frameleaf integrity report · ${title}`,
    `Last run: ${lastRunAt ?? 'never'}`,
    `Findings: ${paths.length}`,
    '',
    ...paths,
  ].join('\n') + '\n';

/** `frameleaf-integrity-<type>-<yyyy-mm-dd-hh-mm-ss>.txt`, from the moment the file is made. */
export const maintenanceReportFileName = (type: string, at: Date): string =>
  `frameleaf-integrity-${type}-${at.toISOString().slice(0, 19).replaceAll(/[:T]/g, '-')}.txt`;
