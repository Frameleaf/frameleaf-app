import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmailRepository, EmailTemplate } from '../../dist/repositories/email.repository.js';

// Import the production build in native ESM: the unit-test transformer can hide bare require() calls.
const repository = new EmailRepository({ setContext() {} });
const baseUrl = 'https://frameleaf.example.test';
const album = { baseUrl, albumId: 'album-123', albumName: 'Family trip', recipientName: 'Jane' };

for (const { template, data, expected } of [
  {
    template: EmailTemplate.TEST_EMAIL,
    data: { baseUrl, displayName: 'Jane' },
    expected: 'This is a test email',
  },
  {
    template: EmailTemplate.WELCOME,
    data: { baseUrl, displayName: 'Jane', username: 'jane' },
    expected: 'A new account has been created for you',
  },
  {
    template: EmailTemplate.ALBUM_INVITE,
    data: { ...album, senderName: 'John' },
    expected: 'Family trip',
  },
  {
    template: EmailTemplate.ALBUM_UPDATE,
    data: album,
    expected: 'Family trip',
  },
]) {
  test(`compiled ${template} renders HTML and plain text without CommonJS globals`, async () => {
    assert.equal(typeof globalThis.require, 'undefined');
    const { html, text } = await repository.renderEmail({ template, data, customTemplate: '' });
    assert.match(html, /<!DOCTYPE html PUBLIC/);
    assert.ok(html.includes(expected));
    assert.ok(text.includes(expected));
    assert.ok(text.includes('Jane'));
    if (template === EmailTemplate.ALBUM_INVITE || template === EmailTemplate.ALBUM_UPDATE) {
      assert.ok(html.includes(`${baseUrl}/albums/album-123`));
      assert.ok(text.includes(`${baseUrl}/albums/album-123`));
    }
  });
}

test('compiled custom album invitation keeps template substitutions', async () => {
  const { html, text } = await repository.renderEmail({
    template: EmailTemplate.ALBUM_INVITE,
    data: { ...album, senderName: 'John' },
    customTemplate: '<strong>{senderName}</strong> invites {recipientName} to {albumName}',
  });
  assert.ok(html.includes('<strong>John</strong> invites Jane to Family trip'));
  assert.ok(text.includes('John invites Jane to Family trip'));
});
