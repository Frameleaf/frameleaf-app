import { goto } from '$app/navigation';
import { MenuItemType } from '../types.js';

export const asQueryString = (params, options) => {
  const { skipEmptyStrings = true, skipNullValues = true } = options ?? {};
  let query = '';
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || (skipNullValues && value === null) || (skipEmptyStrings && value === '')) continue;
    query += `${query ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
  return query;
};

const urlTypes = { issue: 'issues', pr: 'pull', discussion: 'discussions' };
export const asGithubLink = (options) => {
  const {
    org = 'Frameleaf',
    repo = 'frameleaf-app',
    number,
    type = 'pr',
  } = typeof options === 'number' ? { number: options } : (options ?? {});
  const text =
    org === 'Frameleaf' && repo === 'frameleaf-app'
      ? `#${number}`
      : org === 'Frameleaf' || org === repo
        ? `${repo}/#${number}`
        : `${org}/${repo}#${number}`;
  return { href: `https://github.com/${org}/${repo}/${urlTypes[type]}/${number}`, text };
};

export const resolveUrl = (url, _currentHostname) => {
  try {
    const current = globalThis.location;
    const target = new URL(url, current.href);
    return target.origin === current.origin ? url : target.href;
  } catch {
    return url;
  }
};

export const isExternalLink = (href) => {
  try {
    const current = globalThis.location;
    return new URL(href, current.href).origin !== current.origin;
  } catch {
    return false;
  }
};

export const navigateTo = async (url) => {
  const target = resolveUrl(url);
  if (isExternalLink(target)) {
    window.open(target, '_blank', 'noreferrer');
    return;
  }
  await goto(target);
};

export const isMenuItemType = (item) => item === MenuItemType.Divider;

export const resolveMetadata = (site, page, article) => {
  const title = page ? `${page.title} | ${site.title}` : site.title;
  const description = page?.description ?? site.description;
  const imageUrl = page?.imageUrl ?? site?.imageUrl;
  const siteName = page ? `${site.title} — ${site.description}` : site.title;
  return {
    type: article ? 'article' : 'website',
    siteName,
    title,
    description,
    imageUrl,
    article: article
      ? {
          publishedTime: article.publishedTime.toISO(),
          modifiedTime: article.modifiedTime?.toISO(),
          expirationTime: article.expirationTime?.toISO(),
          authors: article.authors,
          section: article.section,
          tags: article.tags,
        }
      : undefined,
  };
};

export const asText = (...items) => {
  let text = '';
  let separator = '';
  for (const item of items) {
    if (item === undefined || item === null) continue;
    text += separator + String(item);
    separator = '|';
  }
  return text.toLowerCase();
};

export const isEnabled = ({ $if }) => !$if || !!$if();
