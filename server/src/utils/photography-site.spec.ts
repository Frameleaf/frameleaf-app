import { describe, expect, it } from 'vitest';
import {
  PhotographySiteSchema,
  defaultPhotographySite,
  normalisePhotographySite,
  portfolioItems,
  siteSlug,
} from 'src/utils/photography-site.js';

const shootId = '0b5f8c3e-8a1d-4f6e-9c2b-1a2b3c4d5e6f';
const a = { shootId, captureId: '1b5f8c3e-8a1d-4f6e-9c2b-1a2b3c4d5e6f' };
const b = { shootId, captureId: '2b5f8c3e-8a1d-4f6e-9c2b-1a2b3c4d5e6f' };

describe('photography site', () => {
  it('makes readable addresses', () => {
    expect(siteSlug('Cedar & Light Studio')).toBe('cedar-and-light-studio');
    expect(siteSlug('Café Élan')).toBe('cafe-elan');
    expect(siteSlug('!!!')).toBe('studio');
    // FL-711: the app's own Studio project library is never a website address.
    expect(siteSlug('Projects')).toBe('studio');
    expect(siteSlug('x'.repeat(60))).toHaveLength(48);
  });

  it('accepts the default site and keeps the cover first and the portfolio on', () => {
    const site = defaultPhotographySite('Studio');
    expect(PhotographySiteSchema.safeParse(site).success).toBe(true);
    const moved = { ...site, sections: [site.sections[1], site.sections[0], ...site.sections.slice(2)] };
    expect(PhotographySiteSchema.safeParse(moved).success).toBe(false);
    const hidden = { ...site, sections: site.sections.map((s) => (s.id === 'portfolio' ? { ...s, on: false } : s)) };
    expect(PhotographySiteSchema.safeParse(hidden).success).toBe(false);
  });

  it('checks domains and the 200-photograph limit', () => {
    const site = defaultPhotographySite('Studio');
    expect(PhotographySiteSchema.safeParse({ ...site, domain: 'Photos.CedarAndLight.ca' }).data?.domain).toBe(
      'photos.cedarandlight.ca',
    );
    expect(PhotographySiteSchema.safeParse({ ...site, domain: 'https://cedar.ca' }).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, index) => ({
      shootId,
      captureId: `${index.toString(16).padStart(8, '0')}-8a1d-4f6e-9c2b-1a2b3c4d5e6f`,
    }));
    const collections = [
      { id: 'one', name: 'One', items: many.slice(0, 150) },
      { id: 'two', name: 'Two', items: many.slice(150) },
    ];
    expect(PhotographySiteSchema.safeParse({ ...site, collections }).success).toBe(false);
  });

  it('lists each photograph once, cover first', () => {
    const site = { cover: b, collections: [{ id: 'x', name: 'X', items: [a, b, a] }] };
    expect(portfolioItems(site)).toEqual([b, a]);
  });

  it('reads a website saved before FL-702', () => {
    const site = normalisePhotographySite(
      {
        presentation: { layout: 'slideshow', spacing: 'airy', font: 'script', palette: 'charcoal' },
        enabled: true,
        title: 'North Studio',
        about: 'Hello',
        services: '',
        contact: 'Write',
        portfolio: [
          { ...a, consent: true },
          { shootId: 'not-a-uuid', captureId: 'x', consent: true },
        ],
      },
      'Fallback',
    );
    expect(site).toMatchObject({
      template: 'cinematic',
      enabled: true,
      title: 'North Studio',
      about: 'Hello',
      contact: 'Write',
      slug: 'north-studio',
      cover: a,
      collections: [{ items: [a] }],
    });
    expect(PhotographySiteSchema.safeParse(site).success).toBe(true);
    expect(normalisePhotographySite(null, 'Fallback').title).toBe('Fallback');
  });
});
