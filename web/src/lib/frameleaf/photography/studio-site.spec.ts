import { describe, expect, it } from 'vitest';
import {
  inquiryProblems,
  moveSection,
  seoPreview,
  siteAddress,
  siteItems,
  slugify,
  toggleSection,
  validDomain,
  validSlug,
} from '$lib/frameleaf/photography/studio-site';
import type { Site } from '$lib/frameleaf/photography/workflow-api';

const sections: Site['sections'] = (
  ['cover', 'portfolio', 'about', 'services', 'testimonials', 'faq', 'inquiry', 'clients'] as const
).map((id) => ({ id, on: id !== 'faq' }));

describe('studio site helpers', () => {
  it('keeps the cover first when moving sections', () => {
    expect(moveSection(sections, 'cover', 1)).toBe(sections);
    expect(moveSection(sections, 'portfolio', -1)).toBe(sections);
    expect(moveSection(sections, 'clients', 1)).toBe(sections);
    expect(
      moveSection(sections, 'about', -1)
        .slice(0, 3)
        .map((s) => s.id),
    ).toEqual(['cover', 'about', 'portfolio']);
  });

  it('never turns off the cover or portfolio', () => {
    expect(toggleSection(sections, 'portfolio').find((s) => s.id === 'portfolio')?.on).toBe(true);
    expect(toggleSection(sections, 'faq').find((s) => s.id === 'faq')?.on).toBe(true);
  });

  it('makes and checks addresses', () => {
    expect(slugify('Cedar & Light Studio')).toBe('cedar-and-light-studio');
    expect(validSlug('cedar-and-light')).toBe(true);
    expect(validSlug('cedar-')).toBe(false);
    expect(validDomain('')).toBe(true);
    expect(validDomain('photos.cedarandlight.ca')).toBe(true);
    expect(validDomain('https://cedar.ca')).toBe(false);
    expect(siteAddress({ slug: 'cedar', domain: '' }, 'https://photos.example')).toBe(
      'https://photos.example/studio/cedar',
    );
    expect(siteAddress({ slug: 'cedar', domain: ' Cedar.ca ' }, 'https://photos.example')).toBe('https://cedar.ca');
  });

  it('checks an inquiry', () => {
    expect(inquiryProblems({ name: '', email: 'x', message: '' })).toEqual(['name', 'email', 'message']);
    expect(inquiryProblems({ name: 'Sam', email: 'sam@example.com', message: 'Hi' })).toEqual([]);
  });

  it('trims search previews like a search result', () => {
    const preview = seoPreview({ seoTitle: 'x'.repeat(70), seoDescription: '', title: 'Studio' } as Site, 'Tagline');
    expect(preview.title).toHaveLength(60);
    expect(preview.titleLong).toBe(true);
    expect(preview.description).toBe('Tagline');
  });

  it('lists each photograph once, cover first', () => {
    const a = { shootId: 's', captureId: 'a' };
    const b = { shootId: 's', captureId: 'b' };
    expect(siteItems({ cover: b, collections: [{ id: 'x', name: 'X', items: [a, b] }] })).toEqual([b, a]);
  });
});
