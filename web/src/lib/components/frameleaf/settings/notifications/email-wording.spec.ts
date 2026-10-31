import {
  FIRST_LINE,
  senderOf,
  senderParts,
  shownSender,
  standardWithFirstLine,
  toTemplate,
  toWords,
  withSamples,
  WORDINGS,
} from '$lib/components/frameleaf/settings/notifications/email-wording';
import en from '../../../../../../../i18n/en.json';

/** ADMIN-P3: the emails' wording in plain words over the server's templates, and who they come from. */
const copy: Record<string, unknown> = en;
const t = (key: string) => {
  const value = copy[key];
  return typeof value === 'string' ? value : key;
};
const [welcome, invite] = WORDINGS;

describe('the first line of an invitation (FL-426)', () => {
  it('names the person and who shared it in brackets, and keeps codes for the server', () => {
    const stored = 'Hi {recipientName}, {senderName} shared something';
    const words = toWords(stored, FIRST_LINE, t);
    expect(words).toBe('Hi [Person’s name], [Who shared it] shared something');
    expect(toTemplate(words, FIRST_LINE, t)).toBe(stored);
  });

  it('opens the standard invitation with it, and leaves the other emails and own wording alone', () => {
    const update = WORDINGS[2];
    expect(standardWithFirstLine(t(invite.standard), invite, 'Hi [Person’s name]')).toBe(
      'Hi [Person’s name]\n\n[Who shared it] has added you to the album [Album name].',
    );
    expect(standardWithFirstLine(t(invite.standard), invite, '  ')).toBe(t(invite.standard));
    expect(standardWithFirstLine(t(update.standard), update, 'Hi')).toBe(t(update.standard));
  });
});

describe('email wording in plain words', () => {
  it('shows codes as names and line breaks as new lines, and writes them back the same', () => {
    const template = 'Hi {recipientName}!<br>{senderName} shared {albumName}: {baseUrl}/albums/{albumId}';
    const words = toWords(template, invite, t);

    expect(words).toBe('Hi [Person’s name]!\n[Who shared it] shared [Album name]: [Link to the album]');
    expect(toTemplate(words, invite, t)).toBe(template);
  });

  it('keeps a template with its own markup exactly as written', () => {
    const template = '<p>Hello <b>{displayName}</b></p>\n<p>Sign in at {baseUrl}</p>';
    const words = toWords(template, welcome, t);

    expect(words).toBe('<p>Hello <b>[Person’s name]</b></p>\n<p>Sign in at [Link to Frameleaf]</p>');
    expect(toTemplate(words, welcome, t)).toBe(template);
  });

  it('previews the words, or the standard wording, with sample names', () => {
    expect(withSamples('Hello [Person’s name]', welcome, t)).toBe('Hello Morgan');
    expect(withSamples(t(invite.standard), invite, t)).toBe(
      'Hey Morgan!\n\nTaylor has added you to the album Summer in the Rockies.',
    );
  });
});

describe('who an email is from', () => {
  it('reads a name and an address, a quoted name, or a bare address', () => {
    expect(senderParts('Rivera photos <photos@example.com>')).toEqual({
      name: 'Rivera photos',
      address: 'photos@example.com',
    });
    expect(senderParts('"Rivera, home" <photos@example.com>')).toEqual({
      name: 'Rivera, home',
      address: 'photos@example.com',
    });
    expect(senderParts('photos@example.com')).toEqual({ name: '', address: 'photos@example.com' });
  });

  it('writes a sender back, quoting a name an address could mistake', () => {
    expect(senderOf('Rivera photos', 'photos@example.com')).toBe('Rivera photos <photos@example.com>');
    expect(senderOf('Rivera, home', 'photos@example.com')).toBe('"Rivera, home" <photos@example.com>');
    expect(senderOf(' ', 'photos@example.com')).toBe('photos@example.com');
  });

  it('shows a signed-in account’s own address unless the saved sender uses it', () => {
    expect(shownSender('Rivera photos <photos@example.com>', 'rivera@gmail.com')).toEqual({
      name: '',
      address: 'rivera@gmail.com',
    });
    expect(shownSender('Rivera photos <Rivera@gmail.com>', 'rivera@gmail.com')).toEqual({
      name: 'Rivera photos',
      address: 'Rivera@gmail.com',
    });
  });
});
