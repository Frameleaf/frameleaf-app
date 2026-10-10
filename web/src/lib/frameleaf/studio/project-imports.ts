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
  importStudioProjectFile,
  StudioProjectImportKind,
  type StudioProjectImportDto,
} from '@frameleaf/sdk';
import { getStudioProjectImportUrl } from '$lib/utils';
import type { StudioProjectImportRef, StudioProjectImportUpload } from './host-contract';

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

export const loadStudioProjectImports = async (projectId: string): Promise<StudioProjectImportRef[]> =>
  (await getStudioProjectImports({ id: projectId }))
    .filter((dto) => isStudioBinImport(dto))
    .map((dto) => toStudioProjectImport(projectId, dto));

export const uploadStudioProjectImport = async (
  projectId: string,
  upload: StudioProjectImportUpload,
): Promise<StudioProjectImportRef> => {
  const file = new File([upload.file], upload.fileName, { type: upload.file.type });
  const dto = await importStudioProjectFile({
    id: projectId,
    studioProjectImportCreateDto: { id: upload.id, file },
  });
  return toStudioProjectImport(projectId, dto);
};
