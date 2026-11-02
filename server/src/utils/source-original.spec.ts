import { parseSourceOriginalPath, sourceOriginalPath } from 'src/utils/source-original.js';

const id = '11111111-1111-4111-8111-111111111111';
const resourceKey = 'a'.repeat(64);
it('round-trips a logical approved resource identity without a package or desktop path', () => {
  const path = sourceOriginalPath({ sourceId: id, resourceKey });
  expect(path).toBe(`frameleaf-source://${id}/${resourceKey}`);
  expect(parseSourceOriginalPath(path)).toEqual({ sourceId: id, resourceKey });
});
it.each(['/nas/photo.jpg', String.raw`C:\Photos\photo.jpg`, '/nas/frameleaf-source:photo.jpg'])(
  'leaves ordinary local originals unchanged: %s',
  (path) => expect(parseSourceOriginalPath(path)).toBeUndefined(),
);
it.each([
  `frameleaf-source://${id}/${resourceKey}/../private`,
  `frameleaf-source://${id}/${resourceKey}?path=/private`,
  `frameleaf-source://${id}/%61${resourceKey.slice(1)}`,
  `FRAMELEAF-SOURCE://${id}/${resourceKey}`,
  `frameleaf-source:${id}/${resourceKey}`,
  `frameleaf-source://user@${id}/${resourceKey}`,
  `frameleaf-source://00000000-0000-0000-0000-000000000000/${resourceKey}`,
  `frameleaf-source://${id}/${resourceKey.toUpperCase()}`,
  `frameleaf-source://${id}/${resourceKey}\n`,
  `frameleaf-source://${id}/${resourceKey}\r\n`,
])('refuses malformed reserved identities instead of falling back to a local read: %s', (path) => {
  expect(() => parseSourceOriginalPath(path)).toThrow('source_reference_invalid');
});
