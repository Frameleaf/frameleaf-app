import type { HelpArticleDto, HelpHeadingDto, HelpIndexResponseDto } from '@frameleaf/sdk';
import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';
import { Marked } from 'marked';
import type { Translations } from 'svelte-i18n';
import { resolveSettingsArea } from '$lib/frameleaf/settings-areas';

/**
 * In-app help (FL-489): which help belongs to the screen you're on, searching the help articles, and
 * showing an article. The articles are frameleaf.app's, served by this server (`GET /help/index`);
 * the screen keys are the website's (`src/data/app-screens.ts` in fl-app-website).
 */

/** Older admin pages that now live in a Settings area. */
const ADMIN_AREAS: Record<string, string> = {
  'jobs-status': 'processing',
  queues: 'processing',
  'render-workers': 'processing',
  'processing-destinations': 'processing',
  'server-status': 'overview',
  'library-management': 'libraries',
  maintenance: 'maintenance',
  'physical-deduplication': 'utilities',
  users: 'users',
  'user-management': 'users',
};

/** Library pages that share another page's help. */
const SAME_HELP: Record<string, string> = {
  favorites: 'photos',
  archive: 'photos',
  'recently-added': 'photos',
  'best-photos': 'photos',
  memory: 'memories',
  partners: 'sharing',
  share: 'sharing',
};

/** The help screen key for a page, such as `photos` or `settings:processing`. */
export const helpScreenFor = (
  url: { pathname: string; searchParams: { get: (name: string) => string | null } },
  isAdmin = false,
): string => {
  const [first = '', second = ''] = url.pathname.split('/', 4).filter(Boolean);
  if (first === 'user-settings') {
    const area = resolveSettingsArea({
      area: url.searchParams.get('area'),
      isOpen: url.searchParams.get('isOpen'),
      isAdmin,
    });
    return `settings:${area}`;
  }
  if (first === 'admin') {
    return `settings:${ADMIN_AREAS[second] ?? 'overview'}`;
  }
  return SAME_HELP[first] ?? first;
};

/** The translation that names a screen in "Help for …": the page's own name, or the Settings area's. */
const SCREEN_NAMES: Record<string, string> = {
  photos: 'library',
  albums: 'all_albums',
  people: 'people',
  pets: 'frameleaf_pets_title',
  explore: 'explore',
  search: 'search',
  memories: 'memories',
  map: 'map',
  places: 'places',
  sharing: 'sharing',
  'shared-links': 'shared_links',
  studio: 'frameleaf_studio_title',
  activity: 'activity',
  folders: 'folders',
  tags: 'tags',
  documents: 'frameleaf_documents_title',
  locked: 'frameleaf_locked',
  trash: 'trash',
  utilities: 'utilities',
  workflows: 'workflows',
};
export const screenNameKey = (screen: string): Translations => {
  if (!screen.startsWith('settings:')) {
    return (SCREEN_NAMES[screen] ?? 'frameleaf_help_panel_general') as Translations;
  }
  const area = screen.slice('settings:'.length);
  // the Utilities area is titled with the page's own name (SettingsHost.svelte)
  return (area === 'utilities' ? 'utilities' : `frameleaf_settings_area_${area}`) as Translations;
};

/** What the help panel read, kept for the page load; the server keeps it fresh from the help website. */
export const helpCache: { index?: HelpIndexResponseDto; articles: Map<string, string> } = { articles: new Map() };
/** Forget what was read, as a new page load would (tests). */
export const resetHelpCache = () => {
  helpCache.index = undefined;
  helpCache.articles.clear();
};

/** Guides shown when a screen has none of its own. */
const GENERAL_HELP = ['start/first-steps', 'using/library', 'help/faq'];

/** The guides for a screen, most useful first. */
export const screenArticles = (index: HelpIndexResponseDto, screen: string): HelpArticleDto[] => {
  const byId = new Map(index.articles.map((article) => [article.id, article]));
  const ids = index.screenGuides[screen] ?? GENERAL_HELP;
  return ids.map((id) => byId.get(id)).filter((article) => article !== undefined);
};

const STOP_WORDS = new Set(
  'how do does my the an to and of in on can what which why is are with for it this that me some not from up get'.split(
    ' ',
  ),
);
const words = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

export type HelpHit = { article: HelpArticleDto; heading: HelpHeadingDto | null; score: number };

/**
 * Help articles for a query, best first. Every word must appear somewhere; a title match weighs most,
 * then a section heading, the summary and the text. The section a word names is returned with the hit.
 * ponytail: plain term scoring over ~100 articles, run in the browser; an index of thousands would want MiniSearch.
 */
export const searchHelp = (articles: HelpArticleDto[], query: string, limit = 8): HelpHit[] => {
  const terms = words(query);
  if (terms.length === 0) {
    return [];
  }
  const hit = (text: string, term: string) => words(text).some((word) => word.startsWith(term));
  const hits: HelpHit[] = [];
  for (const article of articles) {
    let score = 0;
    let heading: HelpHeadingDto | null = null;
    let missing = false;
    for (const term of terms) {
      const inTitle = hit(article.title, term);
      const section = article.headings.find((item) => hit(item.title, term));
      const inSummary = hit(article.description, term);
      const inText = hit(article.intro, term) || hit(article.text, term);
      if (!inTitle && !section && !inSummary && !inText) {
        missing = true;
        break;
      }
      score += (inTitle ? 6 : 0) + (section ? 3 : 0) + (inSummary ? 2 : 0) + (inText ? 1 : 0);
      if (section && !inTitle) {
        heading ??= section;
      }
    }
    if (!missing) {
      // a section named by every word ("shared links") is what was asked for
      const named = article.headings.find((item) => terms.every((term) => hit(item.title, term)));
      if (named) {
        score += 5 * terms.length;
        heading = named;
      }
      hits.push({ article, heading, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title)).slice(0, limit);
};

/** A heading's anchor on the website (github-slugger, as Starlight makes them). */
export const headingAnchor = (title: string) =>
  title
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .replaceAll(/\s/g, '-');

export const helpArticleUrl = (origin: string, article: Pick<HelpArticleDto, 'url'>, heading?: string | null) =>
  `${origin}${article.url}${heading ? `#${headingAnchor(heading)}` : ''}`;

const marked = new Marked({ gfm: true });
/** Web pages, email addresses, pages of the help website and same-page anchors; never `javascript:` and the like. */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|\/(?!\/)|#)/i;
let purifier: Purifier | undefined;
const escapeHtml = (text: string) => text.replaceAll(/[&<>"']/g, (character) => `&#${character.codePointAt(0)};`);
const ASIDE = /^:::(note|tip|caution|danger)(?:\[([^\]\n]*)\])?\n([\s\S]*?)^:::$/gm;

/**
 * An article's Markdown as safe HTML for the reader. The title and "Source:" line are dropped (the
 * panel shows them), Starlight asides become `<aside data-kind>`, and links to other guides carry
 * `data-help-article` (and `data-help-heading`) so the reader opens them in place; every other link
 * opens in a new tab. Images and links stay on the help website.
 */
/** A link's heading anchor, decoded; a malformed escape (`#100%-sure`) stays as written. */
const decodeAnchor = (hash: string) => {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
};

export const renderHelpArticle = (markdown: string, origin: string, ids: ReadonlySet<string>) => {
  const body = markdown
    .replace(/^# .*\n+/, '')
    .replace(/^Source: \S+\n+/, '')
    .replaceAll(
      ASIDE,
      // marker paragraphs around the aside, wrapped once the HTML is clean
      (_match, kind: string, title: string | undefined, text: string) =>
        `\n[!${kind}]\n\n${title ? `**${title}**\n\n` : ''}${text.trimEnd()}\n\n[!end]\n\n`,
    );
  purifier ??= DOMPurify(globalThis);
  if (!purifier.isSupported) {
    // a browser DOMPurify cannot work in gets the text, never unchecked markup
    return `<pre>${escapeHtml(body)}</pre>`;
  }
  const html = purifier.sanitize(marked.parse(body, { async: false }), {
    ALLOWED_TAGS: [
      'a',
      'blockquote',
      'br',
      'code',
      'em',
      'h2',
      'h3',
      'h4',
      'hr',
      'img',
      'li',
      'ol',
      'p',
      'pre',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt'],
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_TRUSTED_TYPE: false,
  });
  const root = document.createElement('div');
  root.innerHTML = html;
  for (const start of root.querySelectorAll('p')) {
    const kind = /^\[!(note|tip|caution|danger)\]$/.exec(start.textContent ?? '')?.[1];
    if (!kind) {
      continue;
    }
    const aside = document.createElement('aside');
    aside.dataset.kind = kind;
    for (let next = start.nextElementSibling; next && next.textContent !== '[!end]'; next = start.nextElementSibling) {
      aside.append(next);
    }
    start.nextElementSibling?.remove();
    start.replaceWith(aside);
  }
  for (const heading of root.querySelectorAll('h2, h3')) {
    heading.id = headingAnchor(heading.textContent ?? '');
  }
  for (const image of root.querySelectorAll('img')) {
    const source = image.getAttribute('src');
    if (source) {
      image.setAttribute('src', new URL(source, origin).href);
      image.setAttribute('loading', 'lazy');
    } else {
      image.remove();
    }
  }
  for (const link of root.querySelectorAll('a')) {
    const target = new URL(link.getAttribute('href') ?? '', origin);
    const id =
      target.origin === new URL(origin).origin
        ? /^\/docs\/([a-z0-9-]+\/[a-z0-9-]+)\/$/.exec(target.pathname)?.[1]
        : undefined;
    if (id && ids.has(id)) {
      link.dataset.helpArticle = id;
      if (target.hash) {
        link.dataset.helpHeading = decodeAnchor(target.hash.slice(1));
      }
    } else if (target.hash && target.pathname === '/' && !link.getAttribute('href')?.startsWith('http')) {
      link.dataset.helpHeading = decodeAnchor(target.hash.slice(1));
    } else {
      link.setAttribute('href', target.href);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer');
    }
  }
  // eslint-disable-next-line unicorn/prefer-dom-node-html-methods -- getHTML is missing from jsdom (the sanitizer's test DOM)
  return root.innerHTML;
};
