import { describe, expect, it } from 'vitest';
import {
  clearPreview,
  createPreview,
  readPreview,
  releaseCandidates,
} from './preview';
const binding = {
  origin: 'https://frameleaf.example',
  serverId: 'server',
  userId: 'user',
  credentialId: 'key',
};
const discovery = {
  tabId: 1,
  documentId: 'doc',
  pageUrl: 'https://example.com/',
  title: 'Example',
  candidates: [],
};
describe('ephemeral collection preview', () => {
  it('drops acquisition URLs after queued bytes are acknowledged without changing the destination', () => {
    const preview = createPreview(binding, {
      ...discovery,
      candidates: [
        {
          id: 'candidate-1',
          url: 'https://images.example/one?signature=private',
          kind: 'image',
          pageUrl: discovery.pageUrl,
          title: 'One',
        },
        {
          id: 'candidate-2',
          url: 'https://images.example/two',
          kind: 'image',
          pageUrl: discovery.pageUrl,
          title: 'Two',
        },
      ],
    });
    const current = releaseCandidates(preview.id, binding, ['candidate-1']);
    expect(current?.binding).toEqual(binding);
    expect(current?.discovery.candidates.map((value) => value.id)).toEqual([
      'candidate-2',
    ]);
    expect(JSON.stringify(readPreview(preview.id, binding))).not.toContain(
      'signature=private',
    );
  });

  it('retains only the latest preview for its original connection, never retargeting it', () => {
    const first = createPreview(binding, discovery, 100);
    expect(readPreview(first.id, binding, 101)).toEqual(first);
    const second = createPreview(binding, discovery, 101);
    expect(readPreview(first.id, binding, 102)).toBeNull();
    expect(readPreview(second.id, binding, 102)).toEqual(second);
    expect(
      readPreview(second.id, { ...binding, userId: 'other' }, 102),
    ).toBeNull();
    expect(readPreview(second.id, binding, 102)).toBeNull();
  });
  it('expires previews and explicitly clears on disconnect/revocation', () => {
    const preview = createPreview(binding, discovery, 100);
    expect(readPreview(preview.id, binding, 100 + 15 * 60 * 1000)).toBeNull();
    const next = createPreview(binding, discovery, 200);
    clearPreview();
    expect(readPreview(next.id, binding, 201)).toBeNull();
  });
});
