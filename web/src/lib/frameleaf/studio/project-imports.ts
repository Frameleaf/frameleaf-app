/**
 * Files kept with a Studio project rather than the library (FL-103 microphone takes, FL-105 media
 * import): the host side of `POST/GET /studio/projects/:id/imports`.
 *
 * The editor gives each imported file its own media id and places clips by it; the server keeps
 * the file under that id, owner-only, and its resolver treats a media id the project declares as
 * that import. The host never trusts the editor's name or type: the server reads both from the
 * bytes, and a refusal (a script in an SVG, a file it cannot place) comes back as an error.
 */
import {
  getStudioProjectImports,
  registerStudioImportPublication,
  getStudioImportPublications,
  cancelStudioImportPublication,
  type StudioImportPublicationDto,
  importStudioProjectFile,
  StudioProjectImportKind,
  type StudioProjectImportDto,
} from '@frameleaf/sdk';
import { getStudioProjectImportUrl } from '$lib/utils';
import type { StudioProjectImportRef, StudioProjectImportUpload, StudioPublicationReceipt } from './host-contract';
import type { RetentionApi } from './import-retention';

/** Freecut reads a Lottie animation by its own type; the server records the JSON it read. */
const editorMimeType = (dto: StudioProjectImportDto) =>
  dto.kind === 'vector' && dto.contentType === 'application/json' ? 'application/lottie+json' : dto.contentType;

export const toStudioProjectImport = (projectId: string, dto: StudioProjectImportDto): StudioProjectImportRef => ({
  id: dto.id,
  kind: dto.kind as StudioProjectImportRef['kind'],
  name: dto.fileName,
  mimeType: editorMimeType(dto),
  sizeBytes: dto.sizeBytes,
  checksum: dto.checksum,
  url: getStudioProjectImportUrl(projectId, dto.id),
  ...(dto.processingProvenance && { processingProvenance: dto.processingProvenance }),
});

/**
 * What the editor's media bin can place. A caption file or a LUT kept with the project is not bin
 * media: the editor would list it as a clip it cannot read, so it is not offered as one.
 */
const binKinds = new Set<StudioProjectImportDto['kind']>([
  StudioProjectImportKind.Audio,
  StudioProjectImportKind.Image,
  StudioProjectImportKind.Video,
  StudioProjectImportKind.Vector,
]);

export const isStudioBinImport = (dto: StudioProjectImportDto) => binKinds.has(dto.kind);

export const loadStudioProjectImports = async (
  projectId: string,
  signal?: AbortSignal,
): Promise<StudioProjectImportRef[]> =>
  (await getStudioProjectImports({ id: projectId }, signal ? { signal } : undefined))
    .filter((dto: StudioProjectImportDto) => isStudioBinImport(dto))
    .map((dto: StudioProjectImportDto) => toStudioProjectImport(projectId, dto));

export const uploadStudioProjectImport = async (
  projectId: string,
  upload: StudioProjectImportUpload,
  signal?: AbortSignal,
): Promise<StudioProjectImportRef> => {
  const file = new File([upload.file], upload.fileName, { type: upload.file.type });
  const dto = await importStudioProjectFile(
    {
      id: projectId,
      studioProjectImportCreateDto: {
        id: upload.id,
        file,
        ...(upload.publicationId !== undefined && { publicationId: upload.publicationId }),
        ...(upload.processingProvenance !== undefined && {
          processingProvenance: JSON.stringify(upload.processingProvenance),
        }),
      },
    },
    signal ? { signal } : undefined,
  );
  return toStudioProjectImport(projectId, dto);
};

/** Pick the public receipt fields; never forward a server row or filesystem declaration. */
export const toStudioPublicationReceipt = (
  projectId: string,
  dto: StudioImportPublicationDto,
): StudioPublicationReceipt => {
  if (dto.imported && (dto.state !== 'published' || dto.imported.id !== dto.importId)) {
    throw new Error('receipt_binding_changed');
  }
  return {
    publicationId: dto.publicationId,
    importId: dto.importId,
    state: dto.state,
    createdAt: dto.createdAt,
    expiresAt: dto.expiresAt,
    cleanupPending: dto.cleanupPending,
    ...(dto.imported &&
      isStudioBinImport(dto.imported) && { imported: toStudioProjectImport(projectId, dto.imported) }),
  };
};

/** SDK transport belongs to the host; the frame receives only public structured results. */
export const createStudioRetentionApi = (signal: AbortSignal): RetentionApi => ({
  register: async (projectId, importId, publicationId) =>
    toStudioPublicationReceipt(
      projectId,
      await registerStudioImportPublication(
        { id: projectId, studioImportPublicationRegisterDto: { importId, publicationId } },
        { signal },
      ),
    ),
  upload: (projectId, upload) => uploadStudioProjectImport(projectId, upload, signal),
  discover: async (projectId, cursor) => {
    const page = await getStudioImportPublications(
      { id: projectId, ...(cursor !== undefined && { cursor }) },
      { signal },
    );
    if (page.items.length > 100) {
      throw new Error('invalid_receipt_page');
    }
    return {
      items: page.items.map((dto: StudioImportPublicationDto) => toStudioPublicationReceipt(projectId, dto)),
      nextCursor: page.nextCursor,
    };
  },
  cancel: async (projectId, importId, publicationId) => {
    const result = await cancelStudioImportPublication({ id: projectId, importId, publicationId }, { signal });
    if (result.receipt.importId !== importId || result.receipt.publicationId !== publicationId) {
      throw new Error('receipt_binding_changed');
    }
    return { status: result.status, receipt: toStudioPublicationReceipt(projectId, result.receipt) };
  },
});
