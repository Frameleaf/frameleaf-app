// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates, filterCandidates } from './candidates';

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('invoked image discovery', () => {
  it('resolves against base but attributes the actual page and deduplicates variants', () => {
    document.head.innerHTML = '<base href="https://cdn.example.com/assets/">';
    document.title = 'Moodboard';
    document.body.innerHTML =
      '<img src="small.jpg" srcset="small.jpg 320w, large.jpg?token=private 1600w"><img src="small.jpg">';
    for (const image of document.querySelectorAll('img'))
      Object.defineProperty(image, 'currentSrc', {
        value: new URL(image.getAttribute('src')!, document.baseURI).href,
      });
    const result = collectCandidates(document);
    expect(result.map((item) => item.url)).toEqual([
      'https://cdn.example.com/assets/large.jpg?token=private',
      'https://cdn.example.com/assets/small.jpg',
    ]);
    expect(result[0]).toMatchObject({
      width: 1600,
      title: 'Moodboard',
      kind: 'image',
    });
    expect(result[0].pageUrl).not.toContain('cdn.example.com');
    expect(new Set(result.map((item) => item.id)).size).toBe(2);
  });
  it('includes currentSrc, available lazy images and CSS backgrounds without loading anything', () => {
    document.body.innerHTML =
      '<img src="https://images.example.com/normal.jpg" data-src="https://images.example.com/lazy.jpg"><div style="background-image: url(https://images.example.com/background.png)"></div>';
    Object.defineProperty(document.querySelector('img'), 'currentSrc', {
      value: 'https://images.example.com/current.webp',
    });
    expect(collectCandidates(document).map((item) => item.url)).toEqual(
      expect.arrayContaining([
        'https://images.example.com/current.webp',
        'https://images.example.com/lazy.jpg',
        'https://images.example.com/background.png',
      ]),
    );
  });
  it('rejects privileged schemes, credentials and oversized inline images', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///private/photo.jpg',
      'https://user:password@example.com/a.jpg',
      'data:text/html,hello',
      'data:image/png;base64,' + 'a'.repeat(262144),
    ]) {
      const img = document.createElement('img');
      img.src = url;
      document.body.append(img);
    }
    expect(collectCandidates(document)).toEqual([]);
  });
  it('keeps commas in URLs and allows bounded image data', () => {
    document.body.innerHTML =
      '<img srcset="https://example.com/a,b.jpg 640w, https://example.com/full.jpg 1280w"><img src="data:image/png;base64,YQ==">';
    expect(collectCandidates(document).map((item) => item.url)).toEqual(
      expect.arrayContaining([
        'https://example.com/a,b.jpg',
        'data:image/png;base64,YQ==',
      ]),
    );
  });
  it('accepts same-origin blobs only and skips oversized srcsets', () => {
    const origin = new URL(document.URL).origin;
    document.body.innerHTML = `<img src="blob:${origin}/local"><img src="blob:https://other.example.com/foreign"><img src="blob:null/opaque">`;
    const image = document.createElement('img');
    image.setAttribute(
      'srcset',
      ' '.repeat(65537) + 'https://example.com/oversized.jpg 100w',
    );
    document.body.append(image);
    expect(collectCandidates(document).map((item) => item.url)).toEqual([
      `blob:${origin}/local`,
    ]);
  });
  it('uses matching picture sources and finite positive dimension hints', () => {
    document.body.innerHTML =
      '<picture><source srcset="https://example.com/full.avif 2000w"><img src="https://example.com/fallback.jpg" srcset="https://example.com/bad.jpg NaNw, https://example.com/negative.jpg -20w"></picture>';
    const result = collectCandidates(document);
    expect(result[0]).toMatchObject({
      url: 'https://example.com/full.avif',
      width: 2000,
    });
    expect(
      result.find((item) => item.url.endsWith('bad.jpg'))?.width,
    ).toBeUndefined();
    expect(
      result.find((item) => item.url.endsWith('negative.jpg'))?.width,
    ).toBeUndefined();
  });
  it('bounds discovery and rejects unproven dimensions when filtering', () => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 1100; index++) {
      const img = document.createElement('img');
      img.src = `https://example.com/${index}.png`;
      fragment.append(img);
    }
    document.body.append(fragment);
    const result = collectCandidates(document);
    expect(result).toHaveLength(1000);
    expect(filterCandidates(result, { minWidth: 500 })).toEqual([]);
    expect(filterCandidates(result, { formats: ['png'] })).toHaveLength(1000);
    expect(filterCandidates(result, { formats: ['jpeg'] })).toEqual([]);
  });
});
