import {
  ImportedFrom,
  LibraryScope,
  addAssetsToAlbums,
  addImportedAssetSource,
  bulkTagAssets,
  createAlbum,
  getAssetInfo,
  setAssetAddedDate,
  updateAsset,
  upsertTags,
} from '@frameleaf/sdk';
import type { EagleAnnotation } from '$lib/frameleaf/eagle/eagle-annotations';
import { fileUploadHandler, type UploadChecksums } from '$lib/utils/file-uploader';

/**
 * What the Eagle import asks of the server, kept small so the import can be tested without one.
 * The upload path the rest of the app uses (it finds files already in the library by their
 * contents), albums with a parent for nested collections, tags, the asset update for rating and
 * note, the imported source address, and the Added date of an item the import brought in.
 */
export interface EagleImportApi {
  createCollection(input: { name: string; parentId?: string; color?: string; description?: string }): Promise<string>;
  /** Tag name → tag id, making the ones that don't exist yet. */
  upsertTags(names: string[]): Promise<Record<string, string>>;
  /** The item the file became, or undefined when it could not be sent. */
  upload(file: File, checksums?: UploadChecksums): Promise<{ assetId: string; duplicate: boolean } | undefined>;
  /** The rating and note an item already has, and when it was added (ISO date). */
  describe(assetId: string): Promise<{ rating: number | null; description: string; addedAt: string }>;
  addToCollections(albumIds: string[], assetId: string): Promise<void>;
  tag(assetId: string, tagIds: string[]): Promise<void>;
  update(assetId: string, changes: { rating?: number; description?: string }): Promise<void>;
  /** Records the item's web address as its Source › Page, marked as from Eagle. Adds it once. */
  addSource(assetId: string, pageUrl: string): Promise<void>;
  /** Moves the item's Added date earlier, to when it was last changed in Eagle. */
  setAdded(assetId: string, addedAt: Date): Promise<void>;
  /** Writes annotations (FL-652). Absent until that API is on main. */
  annotate?: (assetId: string, annotations: EagleAnnotation[]) => Promise<void>;
}

export const frameleafEagleImportApi: EagleImportApi = {
  async createCollection({ name, parentId, color, description }) {
    const album = await createAlbum({
      createAlbumDto: {
        albumName: name,
        libraryScope: LibraryScope.Design,
        ...(parentId && { parentId }),
        ...(color && { color }),
        ...(description && { description }),
      },
    });
    return album.id;
  },
  async upsertTags(names) {
    const tags = await upsertTags({ tagUpsertDto: { tags: names } });
    const wanted = new Set(names);
    return Object.fromEntries(tags.filter(({ value }) => wanted.has(value)).map(({ value, id }) => [value, id]));
  },
  async upload(file, checksums) {
    let result: { assetId: string; duplicate: boolean } | undefined;
    await fileUploadHandler({
      files: [file],
      libraryScope: LibraryScope.Design,
      ...(checksums && { checksums: new Map([[file, checksums]]) }),
      onResult: (_file, { id, duplicate }) => (result = { assetId: id, duplicate }),
    });
    return result;
  },
  async describe(assetId) {
    const asset = await getAssetInfo({ id: assetId });
    return {
      rating: asset.exifInfo?.rating ?? null,
      description: asset.exifInfo?.description ?? '',
      addedAt: asset.createdAt,
    };
  },
  async addToCollections(albumIds, assetId) {
    await addAssetsToAlbums({ albumsAddAssetsDto: { albumIds, assetIds: [assetId] } });
  },
  async tag(assetId, tagIds) {
    await bulkTagAssets({ tagBulkAssetsDto: { assetIds: [assetId], tagIds } });
  },
  async update(assetId, changes) {
    await updateAsset({ id: assetId, updateAssetDto: changes });
  },
  async addSource(assetId, pageUrl) {
    await addImportedAssetSource({ id: assetId, assetSourceImportDto: { importedFrom: ImportedFrom.Eagle, pageUrl } });
  },
  async setAdded(assetId, addedAt) {
    await setAssetAddedDate({ id: assetId, assetAddedDateDto: { addedAt: addedAt.toISOString() } });
  },
};
