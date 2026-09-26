/**
 * Host handlers for the two portable-bundle commands (FL-91, `STU-204`).
 *
 * `project.exportBundle` and `project.importBundle` are FL-91's rows of the command catalogue. The
 * engine never touches a file or the API: it sends the envelope, and these handlers turn it into a
 * durable media operation on the server, which then shows in Activity like a render does. Neither
 * handler changes the open project's graph:
 *
 * - An export writes the project's *stored* revision, so edits still waiting for autosave are
 *   flushed by the caller first, and the revision the editor holds is answered back unchanged.
 *   `includeMedia` in the payload asks for copies of the media the person owns, with the same
 *   meaning as the project library's export dialog: owned media is copied, shared media travels
 *   as a reference and nothing Locked is ever copied (the server enforces all three). When the
 *   payload leaves the choice open, the host asks the person in its own export dialog before
 *   anything is queued; cancelling that dialog queues nothing.
 * - An import always creates a *new* project, never overwrites the open one, and relinks sources
 *   only to items the server authorizes for this account.
 *
 * Exporting a subset of sequences needs the engine to cut the graph, and the engine is not part
 * of this build; that request is refused with a message rather than exporting everything instead.
 */
import {
  exportStudioProjectBundle,
  getStudioBundleUpload,
  importStudioBundle,
  type MediaOperationDto,
  type StudioBundleExportCreateDto,
  type StudioBundleImportCreateDto,
  type StudioBundleUploadDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import type { StudioCommandEnvelope, StudioCommandPayloads } from './commands';
import { studioBundleMapping } from './project-library';

export interface StudioBundleApi {
  exportProject(projectId: string, dto: StudioBundleExportCreateDto): Promise<MediaOperationDto>;
  getUpload(uploadId: string): Promise<StudioBundleUploadDto>;
  importUpload(dto: StudioBundleImportCreateDto): Promise<MediaOperationDto>;
}

export const sdkStudioBundleApi: StudioBundleApi = {
  exportProject: (id, studioBundleExportCreateDto) => exportStudioProjectBundle({ id, studioBundleExportCreateDto }),
  getUpload: (id) => getStudioBundleUpload({ id }),
  importUpload: (studioBundleImportCreateDto) => importStudioBundle({ studioBundleImportCreateDto }),
};

/** A refusal the person can read. The handler throws it; the host shows `messageKey`. */
export class StudioBundleCommandError extends Error {
  constructor(readonly messageKey: Translations) {
    super(messageKey);
  }
}

/** The person closed the export dialog. Nothing was queued and there is nothing to report. */
export class StudioBundleExportCancelled extends Error {
  constructor() {
    super('The export was cancelled');
  }
}

/** The server accepts this shape of idempotency key; anything else is simply not sent. */
const requestKeyPattern = /^[\w.:-]{1,128}$/;
const requestKeyOf = (envelope: StudioCommandEnvelope) =>
  requestKeyPattern.test(envelope.idempotencyKey) ? envelope.idempotencyKey : undefined;

export interface StudioBundleHandlerOptions {
  api?: StudioBundleApi;
  /** The project as the host holds it now: its id and its stored head. */
  project: () => { id: string; revision: number; saved: boolean };
  /**
   * Ask the person whether to include copies of the media they own, for an export whose payload
   * leaves `includeMedia` open. Resolves with their choice, or `null` when they cancel. Without
   * it an open choice means no copies, the server's own default.
   */
  askIncludeMedia?: () => Promise<boolean | null>;
  /** A job was queued; the host points the person at Activity. */
  onQueued: (operation: MediaOperationDto) => void;
  /** A refusal to show. The handler still throws, so the bridge reports the command as failed. */
  onRefused: (messageKey: Translations) => void;
}

export const createStudioBundleHandlers = ({
  api = sdkStudioBundleApi,
  project,
  askIncludeMedia,
  onQueued,
  onRefused,
}: StudioBundleHandlerOptions) => {
  const refuse = (messageKey: Translations): never => {
    onRefused(messageKey);
    throw new StudioBundleCommandError(messageKey);
  };

  /** The payload's explicit choice wins; an open one is asked, and a cancelled question stops here. */
  const chooseIncludeMedia = async (payload: StudioCommandPayloads['project.exportBundle']): Promise<boolean> => {
    if (typeof payload.includeMedia === 'boolean') {
      return payload.includeMedia;
    }
    if (!askIncludeMedia) {
      return false;
    }
    const choice = await askIncludeMedia();
    if (choice === null) {
      throw new StudioBundleExportCancelled();
    }
    return choice;
  };

  return {
    'project.exportBundle': async (envelope: StudioCommandEnvelope) => {
      const payload = envelope.payload as StudioCommandPayloads['project.exportBundle'];
      if (payload.sequenceIds && payload.sequenceIds.length > 0) {
        refuse('frameleaf_studio_bundle_sequences_unavailable');
      }

      // Refusals come before the question: never ask about copies for an export that cannot run.
      const asked = project();
      if (!asked.saved || asked.revision === 0) {
        refuse('frameleaf_studio_bundle_save_first');
      }

      const includeMedia = await chooseIncludeMedia(payload);

      // Read again after the question: the dialog may have stayed open while autosave moved on.
      const current = project();
      let operation: MediaOperationDto;
      try {
        operation = await api.exportProject(current.id, { includeMedia, requestKey: requestKeyOf(envelope) });
      } catch (error) {
        onRefused('frameleaf_studio_bundle_export_failed');
        throw error;
      }
      onQueued(operation);
      // The export reads the stored revision; the editor's graph is unchanged.
      return current.revision;
    },

    'project.importBundle': async (envelope: StudioCommandEnvelope) => {
      const payload = envelope.payload as StudioCommandPayloads['project.importBundle'];
      if (!payload.bundleUploadId) {
        refuse('frameleaf_studio_bundle_error_generic');
      }

      const upload = await api.getUpload(payload.bundleUploadId);
      const operation = await api.importUpload({
        uploadId: upload.id,
        mapping: studioBundleMapping(upload.sources),
        requestKey: requestKeyOf(envelope),
      });
      onQueued(operation);
      // The import makes a new project; the open one is untouched.
      return project().revision;
    },
  };
};

/** Where the owner downloads a finished export. Same origin, so the session cookie applies. */
export const studioBundleDownloadPath = (operationId: string) =>
  `/studio/bundles/exports/${encodeURIComponent(operationId)}/download`;
