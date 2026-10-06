import { goto } from '$app/navigation';
import { MenuItemType } from '../types.js';
export const asQueryString = (params, options) => {
    const { skipEmptyStrings = true, skipNullValues = true } = options ?? {};
    const items = Object.entries(params ?? {})
        .filter((item) => {
        const value = item[1];
        if (value === undefined) {
            return false;
        }
        if (skipNullValues && value === null) {
            return false;
        }
        return !(skipEmptyStrings && value === '');
    })
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    return items.length === 0 ? '' : `?${items.join('&')}`;
};
const urlTypes = {
    issue: 'issues',
    pr: 'pull',
    discussion: 'discussions',
};
const getText = (org, repo, number) => {
    if (org === 'immich-app' && repo === 'immich') {
        return `#${number}`;
    }
    if (org === 'immich-app' || org === repo) {
        return `${repo}/#${number}`;
    }
    return `${org}/${repo}#${number}`;
};
export const asGithubLink = (options) => {
    if (typeof options === 'number') {
        options = { number: options };
    }
    const { org = 'immich-app', repo = 'immich', number, type = 'pr' } = options ?? {};
    return { href: `https://github.com/${org}/${repo}/${urlTypes[type]}/${number}`, text: getText(org, repo, number) };
};
const getImmichApp = (host) => {
    if (!host || !host.endsWith('immich.app')) {
        return false;
    }
    if (host === 'immich.app' || host.startsWith('pr-')) {
        return 'root';
    }
    return host.split('.', 1)[0];
};
export const navigateTo = async (url) => {
    const resolvedUrl = resolveUrl(url);
    const external = isExternalLink(resolvedUrl);
    if (external) {
        window.open(resolvedUrl, '_blank', 'noreferrer');
    }
    else {
        await goto(resolvedUrl);
    }
};
export const resolveUrl = (url, currentHostname) => {
    if (!isExternalLink(url)) {
        return url;
    }
    try {
        const target = new URL(url);
        const targetApp = getImmichApp(target.hostname);
        const currentApp = getImmichApp(currentHostname ?? globalThis.location?.hostname ?? 'ui.immich.app');
        return targetApp && targetApp === currentApp ? target.pathname : target.href;
    }
    catch {
        return url;
    }
};
export const isExternalLink = (href) => {
    try {
        const current = new URL(location.href);
        const target = new URL(href, current);
        return target.origin !== current.origin;
    }
    catch {
        return false;
    }
};
export const isMenuItemType = (item) => {
    return item === MenuItemType.Divider;
};
export const resolveMetadata = (site, page, article) => {
    const title = page ? `${page.title} | ${site.title}` : site.title;
    const description = page?.description ?? site.description;
    const imageUrl = page?.imageUrl ?? site?.imageUrl;
    const siteName = page ? `${site.title} — ${site.description}` : site.title;
    const type = article ? 'article' : 'website';
    return {
        type,
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
    return items
        .filter((item) => item !== undefined && item !== null)
        .map(String)
        .join('|')
        .toLowerCase();
};
export const isEnabled = ({ $if }) => {
    if (!$if) {
        return true;
    }
    return !!$if();
};
