import type {
  getAllAlbums,
  AlbumResponseDto,
  BulkIdResponseDto,
  BulkIdsDto,
  CreateAlbumDto,
  TagBulkAssetsDto,
  TagBulkAssetsResponseDto,
} from '@frameleaf/sdk';

declare module 'extism:host' {
  interface user extends Record<
    (typeof availableFunctions)[number],
    (ptr: PTR) => I64
  > {}
}

type AlbumsToAssets = {
  assetIds: string[];
  albumIds: string[];
};

type HostFunctionSuccessResult<T> = { success: true; response: T };
type HostFunctionErrorResult = {
  success: false;
  status: number;
  message: unknown;
};
type HostFunctionResult<T> =
  HostFunctionSuccessResult<T> | HostFunctionErrorResult;

type QueryParams<T extends (...args: any) => any> = Parameters<T>[0];
type AlbumSearchDto = QueryParams<typeof getAllAlbums>;
type HttpRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
type HttpResponse = {
  ok: boolean;
  status: number;
  body: string;
};

export const availableFunctions = [
  'searchAlbums',
  'createAlbum',
  'addAssetsToAlbum',
  'addAssetsToAlbums',
  'httpRequest',
  'bulkTagAssets',
] as const;

export const hostFunctions = (authToken: string) => {
  const host = Host.getFunctions();
  type HostFunctionName = keyof typeof host;

  const call = <T, R>(name: HostFunctionName, args: T) => {
    const input = Memory.fromString(JSON.stringify({ authToken, args }));
    try {
      const fn = host[name];
      const output = Memory.find(fn(input.offset));
      try {
        const result = JSON.parse(output.readString()) as HostFunctionResult<R>;
        if (result.success) {
          return result.response;
        }
        throw new Error(
          `Failed to call host function "${String(name)}", received ${result.status} - ${JSON.stringify(result.message)}`,
        );
      } finally {
        output.free();
      }
    } finally {
      input.free();
    }
  };

  return {
    // album
    searchAlbums: (dto: AlbumSearchDto) =>
      call<[AlbumSearchDto], AlbumResponseDto[]>('searchAlbums', [dto]),
    createAlbum: (dto: CreateAlbumDto) =>
      call<[CreateAlbumDto], AlbumResponseDto>('createAlbum', [dto]),
    addAssetsToAlbum: (albumId: string, assetIds: string[]) =>
      call<[string, BulkIdsDto], BulkIdResponseDto[]>('addAssetsToAlbum', [
        albumId,
        { ids: assetIds },
      ]),
    addAssetsToAlbums: ({ assetIds, albumIds }: AlbumsToAssets) =>
      call('addAssetsToAlbums', [{ albumIds, assetIds }]),
    httpRequest: (url: string, options?: HttpRequestOptions) =>
      call<[string, HttpRequestOptions | undefined], HttpResponse>(
        'httpRequest',
        [url, options],
      ),
    bulkTagAssets: (dto: TagBulkAssetsDto) =>
      call<[TagBulkAssetsDto], TagBulkAssetsResponseDto>('bulkTagAssets', [
        dto,
      ]),
  } satisfies Record<(typeof availableFunctions)[number], unknown>;
};
