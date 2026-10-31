import {
  mdiAccountOutline,
  mdiEmailOutline,
  mdiFormatQuoteOpen,
  mdiHelpCircleOutline,
  mdiImageOutline,
  mdiLockOutline,
  mdiTagOutline,
  mdiViewGridOutline,
} from '@mdi/js';
import type { Site, SiteSectionId, SiteTemplate } from './workflow-api';

/**
 * FL-702 studio website (FL-701 design, approved 2026-10-30). Each template is a complete design:
 * fonts, page colours, cover and portfolio layout come together, so every choice looks designed.
 */
export const siteTemplates: { id: SiteTemplate; paper: string; text: string; dark: boolean }[] = [
  { id: 'editorial', paper: '#f6f3ec', text: '#26302a', dark: false },
  { id: 'minimal', paper: '#ffffff', text: '#1d1f1e', dark: false },
  { id: 'gallery', paper: '#fbfaf7', text: '#2a2a28', dark: false },
  { id: 'cinematic', paper: '#101211', text: '#ece9e2', dark: true },
  { id: 'noir', paper: '#1a1b1d', text: '#f1efe9', dark: true },
  { id: 'commercial', paper: '#f4f5f2', text: '#141815', dark: false },
];
export const siteTemplate = (id: SiteTemplate) => siteTemplates.find((item) => item.id === id) ?? siteTemplates[0];

export const siteSectionIcons: Record<SiteSectionId, string> = {
  cover: mdiImageOutline,
  portfolio: mdiViewGridOutline,
  about: mdiAccountOutline,
  services: mdiTagOutline,
  testimonials: mdiFormatQuoteOpen,
  faq: mdiHelpCircleOutline,
  inquiry: mdiEmailOutline,
  clients: mdiLockOutline,
};
/** The cover and portfolio are always shown; the cover is always first. */
export const requiredSections: SiteSectionId[] = ['cover', 'portfolio'];
export const MAX_SITE_PHOTOS = 200;

export function moveSection(sections: Site['sections'], id: SiteSectionId, direction: number) {
  const index = sections.findIndex((section) => section.id === id);
  const next = index + direction;
  if (index < 1 || next < 1 || next >= sections.length) {
    return sections;
  }
  const result = [...sections];
  const moved = result[index];
  result[index] = result[next];
  result[next] = moved;
  return result;
}

export const toggleSection = (sections: Site['sections'], id: SiteSectionId) =>
  sections.map((section) =>
    section.id === id && !requiredSections.includes(id) ? { ...section, on: !section.on } : section,
  );

export const sectionOn = (sections: Site['sections'], id: SiteSectionId) =>
  sections.some((section) => section.id === id && section.on);

export function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[̀-ͯ]/g, '')
    .replaceAll('&', ' and ')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48);
}
/** What the server accepts as an address: letters, numbers and dashes, not starting or ending with a dash. */
export const validSlug = (slug: string) => /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug);

export function validDomain(domain: string) {
  const value = domain.trim().toLowerCase();
  return !value || /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

export const siteAddress = (site: Pick<Site, 'slug' | 'domain'>, origin: string) =>
  site.domain.trim() ? `https://${site.domain.trim().toLowerCase()}` : `${origin}/studio/${site.slug}`;

/** Search results cut titles near 60 characters and descriptions near 160. */
export function seoPreview(site: Site, fallbackDescription: string) {
  const title = (site.seoTitle || site.title).trim();
  const description = (site.seoDescription || fallbackDescription).trim();
  return {
    title: title.length > 60 ? `${title.slice(0, 59)}…` : title,
    description: description.length > 160 ? `${description.slice(0, 159)}…` : description,
    titleLong: title.length > 60,
    descriptionLong: description.length > 160,
  };
}

export const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

/** Keys of what an inquiry still needs, in the order the form shows them. */
export function inquiryProblems(inquiry: { name: string; email: string; message: string }) {
  const problems: ('name' | 'email' | 'message')[] = [];
  if (!inquiry.name.trim()) {
    problems.push('name');
  }
  if (!validEmail(inquiry.email)) {
    problems.push('email');
  }
  if (!inquiry.message.trim()) {
    problems.push('message');
  }
  return problems;
}

export const siteItemKey = (item: { shootId: string; captureId: string }) => `${item.shootId}:${item.captureId}`;

/** Every photograph the site shows, once each: the cover first, then each collection. */
export function siteItems(site: Pick<Site, 'cover' | 'collections'>) {
  const seen = new Map<string, { shootId: string; captureId: string }>();
  for (const item of [...(site.cover ? [site.cover] : []), ...site.collections.flatMap((c) => c.items)]) {
    if (!seen.has(siteItemKey(item))) {
      seen.set(siteItemKey(item), item);
    }
  }
  return [...seen.values()];
}
