import { PublicFetchError, fetchPublic } from 'src/utils/public-fetch.js';

/** The page's title and picture for Boards "Save a link" (FL-632); nothing else is kept. */
export type LinkPreview = { title: string | null; image: { contentType: string; data: Buffer } | null };

const PAGE_BYTES = 1024 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text: string) =>
  text
    .replaceAll(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, code: string) => {
      if (code[0] === '#') {
        const value = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(value) && value > 0 && value <= 0x10_ff_ff ? String.fromCodePoint(value) : entity;
      }
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replaceAll(/\s+/g, ' ')
    .trim();

const attribute = (tag: string, name: string) =>
  new RegExp(String.raw`\b${name}\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))`, 'i')
    .exec(tag)
    ?.slice(2)
    .find((v) => v !== undefined);

/** Reads `og:` / `twitter:` meta tags and `<title>` from the head; the body is never parsed. */
export const readPageMeta = (html: string) => {
  const head = html.slice(0, !/<body[\s>]/i.test(html) ? undefined : html.search(/<body[\s>]/i));
  const meta = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name'))?.toLowerCase();
    const content = attribute(tag, 'content');
    if (key && content !== undefined && !meta.has(key)) {
      meta.set(key, decode(content));
    }
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = meta.get('og:title') || meta.get('twitter:title') || (titleTag ? decode(titleTag) : '') || null;
  const image = meta.get('og:image:secure_url') || meta.get('og:image') || meta.get('twitter:image') || null;
  return { title: title ? title.slice(0, 2000) : null, image };
};

export const readLinkPreview = async (address: string): Promise<LinkPreview> => {
  const page = await fetchPublic(address, { maxBytes: PAGE_BYTES, accept: 'text/html,application/xhtml+xml' });
  if (!['text/html', 'application/xhtml+xml'].includes(page.contentType)) {
    return { title: null, image: null };
  }
  const { title, image: imageAddress } = readPageMeta(page.body.toString('utf8'));
  let image: LinkPreview['image'] = null;
  if (imageAddress) {
    try {
      const picture = await fetchPublic(new URL(imageAddress, page.url).href, {
        maxBytes: IMAGE_BYTES,
        accept: [...IMAGE_TYPES].join(','),
      });
      if (IMAGE_TYPES.has(picture.contentType)) {
        image = { contentType: picture.contentType, data: picture.body };
      }
    } catch (error) {
      // A page without a readable picture still gives its title.
      if (!(error instanceof PublicFetchError) && !(error instanceof TypeError)) {
        throw error;
      }
    }
  }
  return { title, image };
};
