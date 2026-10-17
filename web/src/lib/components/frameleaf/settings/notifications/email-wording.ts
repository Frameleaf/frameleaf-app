import type { AdminConfigTemplateEmailsDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

/**
 * ADMIN-P3: the three emails Frameleaf writes, in plain words (the prototype's `WORDINGS` in
 * `settings-v2/server/notifications.jsx`), over the templates the server already keeps
 * (`templates.email.*`). A template is HTML with codes such as `{recipientName}`; on the page each
 * code is its bracketed name ("[Person’s name]") and line breaks are new lines, so a household never
 * sees a code or a tag. What was typed goes back as the same template the server renders.
 */
export type WordingInsert = {
  /** What the server replaces, such as `{recipientName}`. */
  code: string;
  /** Its name on the page, in brackets in the text: "Person’s name". */
  label: Translations;
  /** What the preview shows for it: "Morgan". */
  sample: Translations;
};

/** The settings that hold an email's wording (FL-426 put other email settings beside them). */
export type WordingKey = Extract<keyof AdminConfigTemplateEmailsDto, `${string}Template`>;

export type Wording = {
  key: WordingKey;
  name: Translations;
  when: Translations;
  /** The wording Frameleaf sends when none is set, in the same bracketed words. */
  standard: Translations;
  inserts: readonly WordingInsert[];
};

const PERSON: WordingInsert = {
  code: '{recipientName}',
  label: 'frameleaf_notify_wording_insert_person',
  sample: 'frameleaf_notify_wording_sample_person',
};
const ALBUM: WordingInsert = {
  code: '{albumName}',
  label: 'frameleaf_notify_wording_insert_album',
  sample: 'frameleaf_notify_wording_sample_album',
};
const ALBUM_LINK: WordingInsert = {
  code: '{baseUrl}/albums/{albumId}',
  label: 'frameleaf_notify_wording_insert_album_link',
  sample: 'frameleaf_notify_wording_sample_album_link',
};
const SHARER: WordingInsert = {
  code: '{senderName}',
  label: 'frameleaf_notify_wording_insert_sharer',
  sample: 'frameleaf_notify_wording_sample_sharer',
};

export const WORDINGS: readonly Wording[] = Object.freeze([
  {
    key: 'welcomeTemplate',
    name: 'frameleaf_notify_wording_welcome',
    when: 'frameleaf_notify_wording_welcome_when',
    standard: 'frameleaf_notify_wording_welcome_standard',
    inserts: [
      { ...PERSON, code: '{displayName}' },
      {
        code: '{username}',
        label: 'frameleaf_notify_wording_insert_email',
        sample: 'frameleaf_notify_wording_sample_email',
      },
      {
        code: '{password}',
        label: 'frameleaf_notify_wording_insert_password',
        sample: 'frameleaf_notify_wording_sample_password',
      },
      {
        code: '{baseUrl}',
        label: 'frameleaf_notify_wording_insert_link',
        sample: 'frameleaf_notify_wording_sample_link',
      },
    ],
  },
  {
    key: 'albumInviteTemplate',
    name: 'frameleaf_notify_wording_invite',
    when: 'frameleaf_notify_wording_invite_when',
    standard: 'frameleaf_notify_wording_invite_standard',
    inserts: [PERSON, SHARER, ALBUM, ALBUM_LINK],
  },
  {
    key: 'albumUpdateTemplate',
    name: 'frameleaf_notify_wording_update',
    when: 'frameleaf_notify_wording_update_when',
    standard: 'frameleaf_notify_wording_update_standard',
    inserts: [PERSON, ALBUM, ALBUM_LINK],
  },
]);

/**
 * FL-426: "First line of an invitation" (`templates.email.invitationFirstLine`), one line of plain
 * text in place of the standard greeting of an album or items shared with someone. It takes the same
 * bracketed names as the invitation's wording: the person's name and who shared it.
 */
export const FIRST_LINE: Pick<Wording, 'inserts'> = Object.freeze({ inserts: [PERSON, SHARER] });

type Translate = (key: Translations) => string;

/** Longer codes first, so the album link is matched before the server address inside it. */
const byLongestCode = (inserts: readonly WordingInsert[]) => [...inserts].sort((a, b) => b.code.length - a.code.length);

/** HTML other than line breaks: such a template is shown and kept exactly as written. */
const hasMarkup = (text: string) => /<(?!br\s*\/?>)[a-z!/]/i.test(text);

/**
 * The standard wording with an invitation's own first line in place of its greeting (FL-426), as
 * the server sends it. Only the album invitation has such a line; the other emails keep theirs.
 */
export const standardWithFirstLine = (standard: string, wording: Wording, firstLine: string): string =>
  wording.key === 'albumInviteTemplate' && firstLine.trim()
    ? [firstLine.trim(), ...standard.split('\n').slice(1)].join('\n')
    : standard;

/** A stored template in plain words: codes as bracketed names, line breaks as new lines. */
export const toWords = (template: string, wording: Pick<Wording, 'inserts'>, t: Translate): string => {
  let text = hasMarkup(template) ? template : template.replaceAll(/<br\s*\/?>\n?/gi, '\n');
  for (const insert of byLongestCode(wording.inserts)) {
    // A replacer function: a translated name is inserted as written, never read as a `$&` pattern.
    text = text.replaceAll(insert.code, () => `[${t(insert.label)}]`);
  }
  return text;
};

/** Plain words back as the template the server renders: names as codes, new lines as line breaks. */
export const toTemplate = (words: string, wording: Pick<Wording, 'inserts'>, t: Translate): string => {
  let text = words;
  for (const insert of wording.inserts) {
    text = text.replaceAll(`[${t(insert.label)}]`, () => insert.code);
  }
  return hasMarkup(text) ? text : text.replaceAll('\n', '<br>');
};

/** The words with each bracketed name replaced by its sample, for "Preview with sample names". */
export const withSamples = (words: string, wording: Pick<Wording, 'inserts'>, t: Translate): string => {
  let text = words;
  for (const insert of wording.inserts) {
    text = text.replaceAll(`[${t(insert.label)}]`, () => t(insert.sample));
  }
  return text;
};

/**
 * Who an email is from, as the saved sender says it: `Rivera photos <photos@example.com>` is a name
 * and an address, a bare address has no name.
 */
export const senderParts = (sender: string): { name: string; address: string } => {
  const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^<>]+)>\s*$/.exec(sender);
  if (!match) {
    return { name: '', address: sender.trim() };
  }
  const name = match[1] === undefined ? (match[2] ?? '') : match[1].replaceAll(/\\(.)/g, '$1');
  return { name: name.trim(), address: match[3].trim() };
};

/** A sender from a name and an address; a name with punctuation an address could mistake is quoted. */
export const senderOf = (name: string, address: string): string => {
  const plain = name.trim();
  if (!plain) {
    return address.trim();
  }
  const shown = /[",;:<>@()[\]\\]/.test(plain) ? `"${plain.replaceAll(/(["\\])/g, String.raw`\$1`)}"` : plain;
  return `${shown} <${address.trim()}>`;
};

/**
 * The sender an inbox shows. A signed-in Gmail or Microsoft account only sends as itself, so a saved
 * sender with another address is replaced by the account's own, and one with its address keeps its
 * name (the server's `connectedSender`).
 */
export const shownSender = (saved: string, account?: string): { name: string; address: string } => {
  const parts = senderParts(saved);
  if (account === undefined) {
    return parts;
  }
  return parts.address.toLowerCase() === account.toLowerCase() ? parts : { name: '', address: account };
};
