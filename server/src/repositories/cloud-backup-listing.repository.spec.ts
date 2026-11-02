import { CloudBackupStoreError, CloudBackupStoreRepository } from 'src/repositories/cloud-backup-store.repository.js';
import { CLOUD_BACKUP_PROBE_PREFIX } from 'src/utils/cloud-backup.js';

vi.mock('undici', () => ({ fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));

const connection = {
  endpoint: 'https://storage.test',
  bucket: 'backup',
  region: 'test-region',
  accessKeyId: 'synthetic-access',
  secretAccessKey: 'synthetic-secret',
};
const page = (flag: string, token = '', contents = '') =>
  `<ListBucketResult>${contents}${flag}<NextContinuationToken>${token}</NextContinuationToken></ListBucketResult>`;
const truncated = '<IsTruncated>true</IsTruncated>';
const complete = '<IsTruncated>false</IsTruncated>';
const item = (key: string, size: string) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`;
const store = () => {
  const value = new CloudBackupStoreRepository({ setContext: vi.fn(), warn: vi.fn() } as never);
  value.retryDelaysMs = [];
  return value;
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  page(''),
  page('<IsTruncated>unknown</IsTruncated>'),
  page(truncated),
  page(truncated, 'same'),
  page(complete, '', item('', '1')),
  page(complete, '', item('o/a', 'NaN')),
  page(complete, '', item('o/a', '-1')),
  page(complete, '', item('o/a', '1.5')),
  page(complete, '', item('o/a', '')),
  page(complete, '', '<Contents><Key>o/a</Key></Contents>'),
])('refuses an incomplete or malformed object listing: %s', async (xml) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml)));
  await expect(store().list(connection, '', { continuationToken: 'same' })).rejects.toMatchObject({
    code: 'InvalidListing',
  });
});

it('refuses cyclic object tokens before delivering the repeated page', async () => {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      if (++calls > 3) return Promise.reject(new Error('cycle escaped'));
      return Promise.resolve(new Response(page(truncated, calls === 2 ? 'B' : 'A', item('o/a', '1'))));
    }),
  );
  const onPage = vi.fn().mockResolvedValue(undefined);
  await expect(store().listAll(connection, '', onPage)).rejects.toMatchObject({ code: 'InvalidListing' });
  expect(calls).toBe(3);
  expect(onPage).toHaveBeenCalledTimes(2);
});

it('delivers valid object pages in order using the opaque continuation token', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(page(truncated, 'opaque&amp;token', item('o/a', '0'))))
    .mockResolvedValueOnce(new Response(page(complete, '', item('o/b', '2'))));
  vi.stubGlobal('fetch', fetch);
  const onPage = vi.fn().mockResolvedValue(undefined);
  expect(await store().listAll(connection, 'o/', onPage)).toBe(2);
  expect(
    onPage.mock.calls.map(([rows]) => rows.map(({ key, size }: { key: string; size: number }) => [key, size])),
  ).toEqual([[['o/a', 0]], [['o/b', 2]]]);
  expect(new URL(fetch.mock.calls[1][0]).searchParams.get('continuation-token')).toBe('opaque&token');
});

it.each([undefined, '', '0', 'NaN', '10001', '1'])(
  'refuses missing or nonadvancing multipart markers: %s',
  async (next) => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls++;
        if (calls > 2) return Promise.reject(new Error('marker loop escaped'));
        const marker = calls === 1 ? '1' : next;
        return Promise.resolve(
          new Response(
            `<ListPartsResult>${truncated}${marker === undefined ? '' : `<NextPartNumberMarker>${marker}</NextPartNumberMarker>`}</ListPartsResult>`,
          ),
        );
      }),
    );
    const repository = store() as unknown as {
      multipartParts: (connection: unknown, key: string, uploadId: string) => Promise<unknown>;
    };
    await expect(repository.multipartParts(connection, 'o/a', 'upload')).rejects.toMatchObject({
      code: 'InvalidListing',
    });
    expect(calls).toBe(2);
  },
);

it('retains every part across valid advancing multipart pages', async () => {
  const part = (number: number) =>
    `<Part><PartNumber>${number}</PartNumber><Size>1</Size><ETag>part-${number}</ETag></Part>`;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `<ListPartsResult>${part(1)}${truncated}<NextPartNumberMarker>1</NextPartNumberMarker></ListPartsResult>`,
        ),
      )
      .mockResolvedValueOnce(new Response(`<ListPartsResult>${part(2)}${complete}</ListPartsResult>`)),
  );
  const repository = store() as unknown as {
    multipartParts: (connection: unknown, key: string, uploadId: string) => Promise<unknown>;
  };
  expect(await repository.multipartParts(connection, 'o/a', 'upload')).toEqual([
    { partNumber: 1, size: 1, etag: 'part-1' },
    { partNumber: 2, size: 1, etag: 'part-2' },
  ]);
});

it.each([false, true])(
  'cleans up a probe after a lost PUT response even when deletion fails: %s',
  async (deleteFails) => {
    const repository = store();
    vi.spyOn(repository, 'list').mockResolvedValue({ objects: [], nextToken: null });
    const failed = new CloudBackupStoreError('lost PUT response', null, null);
    let key: string | undefined;
    vi.spyOn(repository, 'put').mockImplementation((_connection, writtenKey) => {
      key = writtenKey;
      return Promise.reject(failed);
    });
    const remove = vi
      .spyOn(repository, 'delete')
      .mockImplementation(() => (deleteFails ? Promise.reject(new Error('cleanup failed')) : Promise.resolve()));
    await expect(repository.probe(connection)).rejects.toBe(failed);
    expect(key?.startsWith(CLOUD_BACKUP_PROBE_PREFIX)).toBe(true);
    expect(remove).toHaveBeenCalledExactlyOnceWith(connection, key);
  },
);
