import type { Ledger } from 'src/commands/migrate/ledger';

/**
 * The audit report is meant to leave the operator's machine: it is read by the administrator
 * in the web Maintenance area (a local, read-only view) and kept as decommission evidence.
 * Everything in it is therefore built from ledger facts plus sanitized text, never from raw
 * error strings, local paths or credentials. The web parser rejects a report that carries
 * any of those, so this module is the single place that decides what may be written.
 */

export const REPORT_FORMAT = 'frameleaf-migration-audit';
export const REPORT_FORMAT_VERSION = 1;
export const MAX_UNRESOLVED_DETAIL = 5000;

export type UnresolvedKind = 'asset' | 'album' | 'tag' | 'stack' | 'person';
export type UnresolvedReason =
  | 'not-transferred'
  | 'transfer-failed'
  | 'absent-on-destination'
  | 'metadata-failed'
  | 'not-created'
  | 'not-linked'
  | 'not-assigned'
  | 'not-attached';

export interface UnresolvedItem {
  kind: UnresolvedKind;
  id: string;
  name: string;
  reason: UnresolvedReason;
  detail?: string;
}

export interface ReportSections {
  owners: Array<{ source: string | null; destination: string }>;
  albums: { total: number; topLevel: number; nested: number; maxDepth: number; created: number; linked: number };
  tags: { total: number; assigned: number };
  people: { total: number; attached: number };
  stacks: { total: number; created: number };
  physicalReferences: {
    newUploads: number;
    matchedExisting: number;
    livePhotoPairs: number;
    livePhotoPairsLinked: number;
  };
  unresolved: UnresolvedItem[];
}

// A token that is a local or server filesystem path: POSIX absolute or home-relative, a
// Windows drive or UNC path, a file: URL, or anything walking up with `..`. A lone slash
// between words ("Trips / Banff", an album path) is not a path. The web parser applies the
// same rule and rejects any report string that matches.
export const FOREIGN_PATH =
  /(?:^|[\s"'(=:,])(?:\/[^\s/]\S*|~[/\\]\S*|[A-Za-z]:[/\\]\S*|\\\\\S+|file:\S*)|(?:^|[/\\])\.\.(?:[/\\]|$)/;

const URL_PATTERN = /\b[a-z][\d+.a-z-]*:\/\/[^\s"'<>]+/gi;
const PATH_TOKEN =
  /(^|[\s"'(=:,])(?:\/[^\s"')/][^\s"')]*|~[/\\][^\s"')]*|[A-Za-z]:[/\\][^\s"')]*|\\\\[^\s"')]+|file:[^\s"')]*)/g;

/** Origin and path only: never credentials, query strings (tokens) or fragments. */
export const sanitizeUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '[url]';
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return '[url]';
  }
};

/** A file name as the user knows it: the last path segment, bounded. */
export const safeName = (value: string | null | undefined): string => {
  const name = (value ?? '').split(/[/\\]/).at(-1) ?? '';
  return name.replaceAll(/\.{2,}/g, '.').slice(0, 255);
};

const HTTP_STATUS = /-> (\d{3}) ([^:]*):/;

/**
 * Short, operator-readable failure text. HTTP failures keep only their status (the body
 * and request path can echo server paths); anything else loses credentials, URL secrets
 * and filesystem paths before it is written.
 */
export const sanitizeDetail = (value: unknown, secrets: string[] = []): string => {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? '');
  const httpStatus = HTTP_STATUS.exec(text);
  if (httpStatus) {
    return `HTTP ${httpStatus[1]} ${httpStatus[2]}`.trim().slice(0, 200);
  }
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      text = text.split(secret).join('[redacted]');
    }
  }
  text = text
    .replaceAll(/x-api-key\S*/gi, '[redacted]')
    .replaceAll(/bearer\s+\S+/gi, '[redacted]')
    .replaceAll(URL_PATTERN, (url) => sanitizeUrl(url))
    .replaceAll(PATH_TOKEN, (_match, lead: string) => `${lead}[path]`)
    .replaceAll(/(^|[/\\])\.\.(?=[/\\]|$)/g, '$1[path]');
  return text.slice(0, 200);
};

type AlbumRow = ReturnType<Ledger['allAlbums']>[number];

function albumHierarchy(albums: AlbumRow[]) {
  const byId = new Map(albums.map((album) => [album.aId, album]));
  // Ancestors from the album up; a cycle or a parent outside this library ends the walk.
  const ancestors = (album: AlbumRow): AlbumRow[] => {
    const chain: AlbumRow[] = [];
    const seen = new Set<string>([album.aId]);
    let current = album;
    while (current.parentAId && byId.has(current.parentAId) && !seen.has(current.parentAId)) {
      current = byId.get(current.parentAId)!;
      seen.add(current.aId);
      chain.push(current);
    }
    return chain;
  };
  const depths = albums.map((album) => ancestors(album).length);
  return {
    topLevel: depths.filter((value) => value === 0).length,
    nested: depths.filter((value) => value > 0).length,
    maxDepth: depths.length > 0 ? Math.max(...depths) : 0,
    path: (album: AlbumRow) =>
      [
        ...ancestors(album)
          .map((item) => item.name)
          .toReversed(),
        album.name,
      ].join(' / '),
  };
}

/**
 * Everything the decommission review needs beyond the asset checksum audit: who owns the
 * library on each side, how the album hierarchy, tags, people and stacks landed, how files
 * reached the destination, and every item still unresolved. `assetUnresolved` comes from
 * the audit pass itself.
 */
export function buildReportSections(
  ledger: Ledger,
  meta: { user: string; sourceUser?: string | null },
  assetUnresolved: UnresolvedItem[],
  assetUnresolvedCount: number,
  secrets: string[] = [],
): { sections: ReportSections; unresolvedCount: number } {
  const unresolved: UnresolvedItem[] = [];
  let unresolvedCount = assetUnresolvedCount - assetUnresolved.length;
  const add = (item: UnresolvedItem) => {
    unresolvedCount++;
    if (unresolved.length < MAX_UNRESOLVED_DETAIL) {
      unresolved.push(item);
    }
  };

  for (const item of assetUnresolved) {
    add(item);
  }
  for (const row of ledger.uploadedWithErrors(MAX_UNRESOLVED_DETAIL)) {
    add({
      kind: 'asset',
      id: row.aId,
      name: safeName(row.filename),
      reason: 'metadata-failed',
      detail: sanitizeDetail(row.error, secrets),
    });
  }

  const albums = ledger.allAlbums();
  const hierarchy = albumHierarchy(albums);
  for (const album of albums) {
    if (!album.bId) {
      add({ kind: 'album', id: album.aId, name: hierarchy.path(album), reason: 'not-created' });
    } else if (!album.linked) {
      add({ kind: 'album', id: album.aId, name: hierarchy.path(album), reason: 'not-linked' });
    }
  }

  for (const tag of ledger.allTags()) {
    if (!tag.assigned) {
      add({ kind: 'tag', id: tag.aId, name: tag.value, reason: 'not-assigned' });
    }
  }

  for (const stack of ledger.unfinishedStacks()) {
    add({ kind: 'stack', id: stack.primaryAId, name: safeName(stack.filename), reason: 'not-created' });
  }

  for (const person of ledger.peopleToDo()) {
    add({ kind: 'person', id: person.aId, name: person.name, reason: 'not-attached' });
  }

  const counts = ledger.counts();
  const routes = ledger.transferRoutes();
  const livePhotos = ledger.livePhotoPairs();
  return {
    unresolvedCount,
    sections: {
      owners: [{ source: meta.sourceUser ?? null, destination: meta.user }],
      albums: {
        total: counts.albumsTotal,
        topLevel: hierarchy.topLevel,
        nested: hierarchy.nested,
        maxDepth: hierarchy.maxDepth,
        created: albums.filter((album) => !!album.bId).length,
        linked: counts.albumsLinked,
      },
      tags: { total: counts.tagsTotal, assigned: counts.tagsAssigned },
      people: { total: counts.peopleTotal, attached: counts.peopleDone },
      stacks: { total: counts.stacksTotal, created: counts.stacksDone },
      physicalReferences: {
        newUploads: routes.upload,
        matchedExisting: routes.duplicate + routes.present,
        livePhotoPairs: livePhotos.total,
        livePhotoPairsLinked: livePhotos.linked,
      },
      unresolved,
    },
  };
}
