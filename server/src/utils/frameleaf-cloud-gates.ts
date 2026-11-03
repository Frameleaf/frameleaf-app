/**
 * FL-544: the one rule table for what a Frameleaf Cloud feature needs, as the user reads it.
 *
 * "Frameleaf Cloud" is sold as one thing: the lifetime licence plus the plan, in one store purchase.
 * Every refusal a cloud feature sends to the web says which of three things is missing (a link,
 * Frameleaf Cloud, or AI credit) in the same words, so the web can show one button for it. Remote
 * access, relay, Cloud Backup and the licence service read these; never write a gate sentence
 * anywhere else. The web's copy of the table is `web/src/lib/frameleaf/cloud-rules.ts`.
 */
const usd = (value: number) => `$${value.toFixed(2)}`;

export const CLOUD_GATES = Object.freeze({
  /** Nothing cloud works before the server is linked to a free Frameleaf account. */
  linkFirst: 'Link this server to a Frameleaf account first.',
  remoteNeedsCloud: 'Remote access is part of Frameleaf Cloud.',
  relayNeedsCloud:
    'Connecting through Frameleaf is part of Frameleaf Cloud. Without it, this server is reached directly.',
  backupNeedsCloud: 'Cloud Backup is part of Frameleaf Cloud.',
  buddyNeedsLicence: 'Buddy Backup needs a Server licence on both servers. Frameleaf Cloud includes one.',
  processingNeedsLicence: 'Cloud processing needs the licence Frameleaf Cloud includes, then AI credit as you go.',
  creditShort: (holdUsd: number, availableUsd: number) =>
    `This job needs ${usd(holdUsd)} held and only ${usd(availableUsd)} of AI credit is available. Add AI credit first.`,
  dailyCap: (capUsd: number) =>
    `Today’s AI credit limit of ${usd(capUsd)} leaves too little for this job. Try again tomorrow or raise the limit in your Frameleaf account.`,
});
