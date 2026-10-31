import { describe, expect, it } from 'vitest';
import { CLOUD_GATES } from 'src/utils/frameleaf-cloud-gates.js';

describe('CLOUD_GATES (FL-544: one rule table for Frameleaf Cloud gate copy)', () => {
  it('names Frameleaf Cloud as the one thing remote access and Cloud Backup need', () => {
    expect(CLOUD_GATES.linkFirst).toBe('Link this server to a Frameleaf account first.');
    expect(CLOUD_GATES.remoteNeedsCloud).toBe('Remote access is part of Frameleaf Cloud.');
    expect(CLOUD_GATES.relayNeedsCloud).toBe(
      'Connecting through Frameleaf is part of Frameleaf Cloud. Without it, this server is reached directly.',
    );
    expect(CLOUD_GATES.backupNeedsCloud).toBe('Cloud Backup is part of Frameleaf Cloud.');
  });

  it('says what Buddy Backup and cloud processing need without naming a plan', () => {
    expect(CLOUD_GATES.buddyNeedsLicence).toBe(
      'Buddy Backup needs a Server licence on both servers. Frameleaf Cloud includes one.',
    );
    expect(CLOUD_GATES.processingNeedsLicence).toBe(
      'Cloud processing needs the licence Frameleaf Cloud includes, then AI credit as you go.',
    );
  });

  it('builds the AI credit refusals with fixed-form US dollar amounts', () => {
    expect(CLOUD_GATES.creditShort(1.5, 0.25)).toBe(
      'This job needs $1.50 held and only $0.25 of AI credit is available. Add AI credit first.',
    );
    expect(CLOUD_GATES.dailyCap(20)).toBe(
      'Today’s AI credit limit of $20.00 leaves too little for this job. Try again tomorrow or raise the limit in your Frameleaf account.',
    );
  });
});
