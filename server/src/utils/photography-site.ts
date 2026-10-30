import z from 'zod';

/**
 * FL-702 studio website (FL-701 design). A site is one of six fixed templates plus the sections the
 * photographer turns on, collections of portfolio photographs and their own words. Stored as JSON in
 * `photography_studio_site.value.site`; sites saved before FL-702 are read through `normalisePhotographySite`.
 */
export const SITE_TEMPLATES = ['editorial', 'minimal', 'gallery', 'cinematic', 'noir', 'commercial'] as const;
export const SITE_SECTIONS = [
  'cover',
  'portfolio',
  'about',
  'services',
  'testimonials',
  'faq',
  'inquiry',
  'clients',
] as const;
/** The cover and portfolio are always shown; the cover is always first. */
export const REQUIRED_SITE_SECTIONS: readonly string[] = ['cover', 'portfolio'];
/** Long edges of the site-owned copies of each portfolio photograph (`srcset`). */
export const SITE_PHOTO_WIDTHS = [640, 1280, 2048] as const;

const Id = z.uuidv4();
// Named, so the generated SDK keeps its existing numbered enum names (Kind10, Id2, …) stable.
export const SiteTemplateSchema = z.enum(SITE_TEMPLATES).meta({ id: 'PhotographySiteTemplate' });
const SiteColoursSchema = z.enum(['template', 'brand']).meta({ id: 'PhotographySiteColours' });
const SiteSectionIdSchema = z.enum(SITE_SECTIONS).meta({ id: 'PhotographySiteSectionId' });
export const SiteInquiryKindSchema = z.enum(['inquiry', 'gallery-link']).meta({ id: 'PhotographySiteInquiryKind' });
export const SITE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const PortfolioItem = z.strictObject({ shootId: Id, captureId: Id });

/** The fields alone (`.pick` refuses a schema with refinements). */
export const PhotographySiteFields = z.strictObject({
  enabled: z.boolean(),
  template: SiteTemplateSchema,
  colours: SiteColoursSchema,
  coverFocal: z.int().min(0).max(100),
  cover: PortfolioItem.nullable(),
  sections: z
    .array(z.strictObject({ id: SiteSectionIdSchema, on: z.boolean() }))
    .length(SITE_SECTIONS.length)
    .refine((sections) => new Set(sections.map((s) => s.id)).size === SITE_SECTIONS.length, 'Repeated section')
    .refine((sections) => sections[0]?.id === 'cover', 'The cover comes first')
    .refine(
      (sections) => sections.every((s) => s.on || !REQUIRED_SITE_SECTIONS.includes(s.id)),
      'The cover and portfolio are always shown',
    ),
  title: z.string().trim().min(1).max(200),
  about: z.string().max(10_000),
  contact: z.string().max(5000),
  collections: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]{1,48}$/),
        name: z.string().trim().min(1).max(60),
        items: z.array(PortfolioItem).max(200),
      }),
    )
    .min(1)
    .max(12),
  packages: z
    .array(z.strictObject({ name: z.string().max(80), price: z.string().max(40), detail: z.string().max(400) }))
    .max(12),
  testimonials: z.array(z.strictObject({ quote: z.string().max(600), name: z.string().max(80) })).max(12),
  faq: z.array(z.strictObject({ q: z.string().max(200), a: z.string().max(2000) })).max(20),
  /** "Trusted by" on the Commercial template: typed by the photographer, never read from client records. */
  trustedBy: z.array(z.string().trim().min(1).max(60)).max(12),
  slug: z.string().regex(SITE_SLUG),
  /** FL-701 decision A: served through the Frameleaf Cloud relay for subscribers. */
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .refine((domain) => domain === '' || DOMAIN.test(domain), 'Enter a domain like cedarandlight.ca'),
  seoTitle: z.string().max(120),
  seoDescription: z.string().max(300),
});
export const PhotographySiteSchema = PhotographySiteFields.superRefine((site, context) => {
  const ids = site.collections.map((c) => c.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Repeated collection' });
  if (portfolioItems(site).length > 200)
    context.addIssue({ code: 'custom', message: 'A website holds at most 200 photographs' });
});
export type PhotographySite = z.infer<typeof PhotographySiteSchema>;
export type PortfolioItem = z.infer<typeof PortfolioItem>;

export const portfolioKey = (item: PortfolioItem) => `${item.shootId}:${item.captureId}`;

/** Every photograph the site shows, once each: the cover first, then each collection in order. */
export function portfolioItems(site: Pick<PhotographySite, 'cover' | 'collections'>) {
  const seen = new Map<string, PortfolioItem>();
  for (const item of [...(site.cover ? [site.cover] : []), ...site.collections.flatMap((c) => c.items)])
    if (!seen.has(portfolioKey(item))) seen.set(portfolioKey(item), item);
  return seen.values().toArray();
}

export function siteSlug(text: string) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[̀-ͯ]/g, '')
    .replaceAll('&', ' and ')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return SITE_SLUG.test(slug) ? slug : 'studio';
}

export function defaultPhotographySite(title: string): PhotographySite {
  return {
    enabled: false,
    template: 'editorial',
    colours: 'template',
    coverFocal: 50,
    cover: null,
    sections: SITE_SECTIONS.map((id) => ({ id, on: id !== 'faq' })),
    title,
    about: '',
    contact: '',
    collections: [{ id: 'work', name: 'Selected work', items: [] }],
    packages: [],
    testimonials: [],
    faq: [],
    trustedBy: [],
    slug: siteSlug(title),
    domain: '',
    seoTitle: '',
    seoDescription: '',
  };
}

type LegacySite = {
  presentation?: { layout?: string };
  enabled?: boolean;
  title?: string;
  about?: string;
  services?: string;
  contact?: string;
  portfolio?: { shootId: string; captureId: string }[];
};

/** Sites saved before FL-702 had one portfolio list and a layout of editorial, grid or slideshow. */
export function normalisePhotographySite(stored: unknown, fallbackTitle: string): PhotographySite {
  const parsed = PhotographySiteSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  const legacy = (stored ?? {}) as LegacySite;
  const site = defaultPhotographySite(legacy.title || fallbackTitle);
  const layout = legacy.presentation?.layout;
  site.template = layout === 'grid' ? 'minimal' : layout === 'slideshow' ? 'cinematic' : 'editorial';
  site.enabled = legacy.enabled === true;
  site.about = [legacy.about, legacy.services].filter(Boolean).join('\n\n').slice(0, 10_000);
  site.contact = (legacy.contact ?? '').slice(0, 5000);
  const items = (legacy.portfolio ?? [])
    .map(({ shootId, captureId }) => ({ shootId, captureId }))
    .filter((item) => PortfolioItem.safeParse(item).success)
    .slice(0, 200);
  site.collections[0].items = items;
  site.cover = items[0] ?? null;
  return site;
}
