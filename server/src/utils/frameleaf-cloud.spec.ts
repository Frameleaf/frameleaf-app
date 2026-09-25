import { describe, expect, it } from 'vitest';
import { type FrameleafDiscoveryDocument, discoveryProblem } from 'src/utils/frameleaf-cloud.js';

// These cases need plain-http addresses to prove they are refused.
/* eslint-disable unicorn/prefer-https */
const document = (overrides: Partial<FrameleafDiscoveryDocument> = {}): FrameleafDiscoveryDocument => ({
  version: 1,
  validFor: 3600,
  issuer: 'https://id.frameleaf.cloud',
  api: 'https://frameleaf.cloud/api',
  ml: { eu: 'https://ml.eu.frameleaf.cloud', na: 'https://ml.na.frameleaf.cloud' },
  ...overrides,
});

describe(discoveryProblem.name, () => {
  it('accepts the configured cloud host and its subdomains over https', () => {
    expect(discoveryProblem('https://frameleaf.cloud', document())).toBeNull();
  });

  it('refuses a token issuer, API or gateway on another host (FL-159)', () => {
    for (const overrides of [
      { issuer: 'https://id.attacker.example' },
      { issuer: 'https://frameleaf.cloud.attacker.example' },
      { issuer: 'https://evilframeleaf.cloud' },
      { api: 'https://api.example.com' },
      { ml: { eu: 'https://ml.eu.frameleaf.cloud', na: 'https://ml.example.net' } },
    ]) {
      expect(discoveryProblem('https://frameleaf.cloud', document(overrides)), JSON.stringify(overrides)).toMatch(
        /is not on frameleaf\.cloud/,
      );
    }
  });

  it('refuses http unless the configured cloud is itself http, and credentials in a URL', () => {
    expect(discoveryProblem('https://frameleaf.cloud', document({ issuer: 'http://id.frameleaf.cloud' }))).toMatch(
      /not https/,
    );
    expect(
      discoveryProblem('http://cloud.test:8080', {
        ...document(),
        issuer: 'http://cloud.test:8080/id',
        api: 'http://cloud.test:8080/api',
        ml: { eu: 'https://ml.eu.cloud.test' },
      }),
    ).toBeNull();
    expect(
      discoveryProblem('https://frameleaf.cloud', document({ api: 'https://user:secret@frameleaf.cloud/api' })),
    ).toMatch(/credentials/);
  });
});
