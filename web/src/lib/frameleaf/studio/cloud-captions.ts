/**
 * Captions on Frameleaf Cloud (FL-1304), as the host offers them to the editor.
 *
 * The editor asks for one clip. The host saves the project, prices the clip and shows the Cloud job
 * dialog; nothing leaves the server until the person confirms. The editor then reads the job until it
 * settles and adds the lines to that clip itself. Jobs are remembered per project, so captions that
 * were paid for still arrive after a reload.
 */
export type StudioCloudCaptionAnchor = { fromSeconds: number; sourceStartSeconds: number; speed: number };

/**
 * FL-1429: one clip of several selected together. Each is still priced and confirmed on its own; the
 * batch only lets the host list the others, and answer the rest with nothing once the person stops.
 */
export type StudioCloudCaptionBatch = {
  id: string;
  index: number;
  clips: Array<{ clipId: string; name: string }>;
};

export type StudioCloudCaptionRequest = {
  clipId: string;
  language: string;
  name: string;
  batch?: StudioCloudCaptionBatch;
};

export type StudioCloudCaptionJob = StudioCloudCaptionRequest & { id: string };

export type StudioCloudCaptionCue = { start: number; end: number; text: string };

export type StudioCloudCaptionState = {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  cues: StudioCloudCaptionCue[];
  /** Where the clip sat in the transcribed revision: cues are in that revision's timeline seconds. */
  anchor: StudioCloudCaptionAnchor | null;
};

const CLIP_ID = /^[\w-]{1,128}$/;
const JOB_ID = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const LANGUAGE = /^[A-Za-z0-9-]{2,35}$/;
const MAX_NAME = 512;
const BATCH_ID = /^[\w-]{1,64}$/;
const MAX_BATCH = 100;
const SETTLED = ['completed', 'failed', 'cancelled'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isStudioCloudCaptionId = (value: unknown): value is string =>
  typeof value === 'string' && JOB_ID.test(value);

const isClipName = (value: unknown): value is { clipId: string; name: string } =>
  isRecord(value) &&
  typeof value.clipId === 'string' &&
  CLIP_ID.test(value.clipId) &&
  typeof value.name === 'string' &&
  value.name.length <= MAX_NAME;

const isBatch = (value: unknown, clipId: string): value is StudioCloudCaptionBatch =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  BATCH_ID.test(value.id) &&
  Array.isArray(value.clips) &&
  value.clips.length >= 2 &&
  value.clips.length <= MAX_BATCH &&
  value.clips.every((clip) => isClipName(clip)) &&
  new Set(value.clips.map((clip: { clipId: string }) => clip.clipId)).size === value.clips.length &&
  Number.isSafeInteger(value.index) &&
  (value.index as number) >= 0 &&
  (value.index as number) < value.clips.length &&
  (value.clips[value.index as number] as { clipId: string }).clipId === clipId;

export const isStudioCloudCaptionRequest = (value: unknown): value is StudioCloudCaptionRequest =>
  isClipName(value) &&
  typeof (value as Record<string, unknown>).language === 'string' &&
  LANGUAGE.test((value as Record<string, unknown>).language as string) &&
  ((value as Record<string, unknown>).batch === undefined ||
    isBatch((value as Record<string, unknown>).batch, value.clipId));

const isJob = (value: unknown): value is StudioCloudCaptionJob =>
  isStudioCloudCaptionRequest(value) && isStudioCloudCaptionId((value as StudioCloudCaptionJob).id);

type Transcription = {
  status: string;
  error: string | null;
  result?: { cues: Array<{ start: Rational; end: Rational; text: string }> } | null;
  placement?: { start: Rational; sourceStart: Rational; speed: Rational } | null;
};
type Rational = { num: number; den: number };

const seconds = ({ num, den }: Rational) => num / den;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const createCloudCaptionServices = ({
  projectId,
  save,
  confirm,
  read,
  storage = localStorage,
}: {
  /** Read on each use: a draft's first save and Save as copy both change it without a remount. */
  projectId: () => string;
  /** The server prices the head revision. Return false when edits could not be saved. */
  save: () => Promise<boolean | void>;
  /** Show the price. Resolves with the confirmed job's id, or null when nothing was sent. */
  confirm: (request: StudioCloudCaptionRequest, projectId: string) => Promise<string | null>;
  read: (projectId: string, id: string) => Promise<Transcription>;
  storage?: Storage;
}) => {
  const key = (project: string) => `frameleaf-studio-cloud-captions:${project}`;
  /** The project each job was confirmed in; the server answers for a job only under that project. */
  const owners = new Map<string, string>();

  const pending = (project: string): StudioCloudCaptionJob[] => {
    try {
      const value: unknown = JSON.parse(storage.getItem(key(project)) ?? '[]');
      return Array.isArray(value) ? value.filter((job) => isJob(job)) : [];
    } catch {
      return [];
    }
  };

  const remember = (project: string, jobs: StudioCloudCaptionJob[]) => {
    try {
      if (jobs.length > 0) {
        storage.setItem(key(project), JSON.stringify(jobs));
      } else {
        storage.removeItem(key(project));
      }
    } catch {
      // Blocked storage only costs resuming after a reload.
    }
  };

  const forget = (project: string, id: string) => {
    remember(
      project,
      pending(project).filter((job) => job.id !== id),
    );
    owners.delete(id);
  };

  return {
    startCloudCaptions: async (request: StudioCloudCaptionRequest): Promise<StudioCloudCaptionJob | null> => {
      if ((await save()) === false) {
        return null;
      }
      const project = projectId();
      const id = await confirm(request, project);
      if (!id) {
        return null;
      }
      // The batch only matters while it is being confirmed; a remembered job is one clip.
      const job = { clipId: request.clipId, language: request.language, name: request.name, id };
      owners.set(id, project);
      remember(project, [...pending(project).filter((existing) => existing.id !== id), job]);
      // Confirmation may settle after Save as copy. The original can resume it when reopened.
      return projectId() === project ? job : null;
    },

    readCloudCaptions: async (id: string): Promise<StudioCloudCaptionState> => {
      const project = owners.get(id) ?? projectId();
      const transcription = await read(project, id);
      const settled = SETTLED.find((value) => value === transcription.status) ?? 'running';
      const { placement } = transcription;
      // A completed job always carries its result and placement; without them there is nothing to add.
      const status = settled === 'completed' && (!transcription.result || !placement) ? 'failed' : settled;
      // A completed job stays until the editor has added its lines or the person has kept their own.
      if (status === 'failed' || status === 'cancelled') {
        forget(project, id);
      }
      const cues = transcription.result?.cues ?? [];
      return {
        status,
        error: transcription.error,
        cues: cues.map(({ start, end, text }) => ({
          start: start.num / start.den,
          end: end.num / end.den,
          text,
        })),
        anchor: placement
          ? {
              fromSeconds: seconds(placement.start),
              sourceStartSeconds: seconds(placement.sourceStart),
              speed: seconds(placement.speed),
            }
          : null,
      };
    },

    forgetCloudCaptions: (id: string): Promise<void> => {
      forget(owners.get(id) ?? projectId(), id);
      return Promise.resolve();
    },

    pendingCloudCaptions: (): Promise<StudioCloudCaptionJob[]> => {
      const project = projectId();
      const jobs = pending(project);
      // A reload forgets who owned them, and Save as copy may still change the id while they run.
      for (const job of jobs) {
        owners.set(job.id, project);
      }
      return Promise.resolve(jobs);
    },
  };
};

/**
 * The words of Cloud captions inside the editor, translated by the host like the other cards the
 * engine draws (`host-engine-strings.ts`).
 */
export const CLOUD_CAPTION_ENGINE_STRINGS = {
  cloudCaptionsRunOn: { host: 'frameleaf_studio_cloud_captions_run_on', engine: 'transcript.cloud.runOn' },
  cloudCaptionsDevice: { host: 'frameleaf_studio_cloud_captions_device', engine: 'transcript.cloud.device' },
  cloudCaptionsCloud: { host: 'frameleaf_studio_cloud_captions_cloud', engine: 'transcript.cloud.cloud' },
  cloudCaptionsSeePrice: { host: 'frameleaf_studio_cloud_captions_see_price', engine: 'transcript.cloud.seePrice' },
  cloudCaptionsNote: { host: 'frameleaf_studio_cloud_captions_note', engine: 'transcript.cloud.note' },
  cloudCaptionsAdded: {
    host: 'frameleaf_studio_cloud_captions_added',
    engine: 'transcript.cloud.added',
    values: ['name'],
  },
  cloudCaptionsReadyTitle: {
    host: 'frameleaf_studio_cloud_captions_ready_title',
    engine: 'transcript.cloud.readyTitle',
    values: ['name'],
  },
  cloudCaptionsReadyBody: {
    host: 'frameleaf_studio_cloud_captions_ready_body',
    engine: 'transcript.cloud.readyBody',
    values: ['lines', 'existing'],
  },
  cloudCaptionsReplace: { host: 'frameleaf_studio_cloud_captions_replace', engine: 'transcript.cloud.replace' },
  cloudCaptionsKeep: { host: 'frameleaf_studio_cloud_captions_keep', engine: 'transcript.cloud.keep' },
  cloudCaptionsFailed: {
    host: 'frameleaf_studio_cloud_captions_failed',
    engine: 'transcript.cloud.failed',
    values: ['name'],
  },
  cloudCaptionsBatchMenu: {
    host: 'frameleaf_studio_cloud_captions_batch_menu',
    engine: 'transcript.cloud.batchMenu',
    values: ['count'],
  },
  cloudCaptionsBatchTitle: {
    host: 'frameleaf_studio_cloud_captions_batch_list_title',
    engine: 'transcript.cloud.batchTitle',
    values: ['count'],
  },
  cloudCaptionsBatchNote: { host: 'frameleaf_studio_cloud_captions_batch_note', engine: 'transcript.cloud.batchNote' },
  cloudCaptionsBatchReview: {
    host: 'frameleaf_studio_cloud_captions_batch_review',
    engine: 'transcript.cloud.batchReview',
  },
  cloudCaptionsBatchNoSound: {
    host: 'frameleaf_studio_cloud_captions_batch_no_sound',
    engine: 'transcript.cloud.batchNoSound',
  },
  cloudCaptionsBatchRunning: {
    host: 'frameleaf_studio_cloud_captions_batch_running',
    engine: 'transcript.cloud.batchRunning',
  },
  cloudCaptionsGone: {
    host: 'frameleaf_studio_cloud_captions_gone',
    engine: 'transcript.cloud.gone',
    values: ['name'],
  },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type CloudCaptionEngineString = keyof typeof CLOUD_CAPTION_ENGINE_STRINGS;

type CloudCaptionHostKey = (typeof CLOUD_CAPTION_ENGINE_STRINGS)[CloudCaptionEngineString]['host'];
type Translate = (key: CloudCaptionHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every string, with engine markers left in place. */
export function cloudCaptionEngineStrings(translate: Translate): Record<CloudCaptionEngineString, string> {
  const strings = {} as Record<CloudCaptionEngineString, string>;
  for (const [name, entry] of Object.entries(CLOUD_CAPTION_ENGINE_STRINGS) as Array<
    [CloudCaptionEngineString, { host: CloudCaptionHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
