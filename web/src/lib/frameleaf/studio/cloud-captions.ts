/**
 * Captions on Frameleaf Cloud (FL-1304), as the host offers them to the editor.
 *
 * The editor asks for one clip. The host saves the project, prices the clip and shows the Cloud job
 * dialog; nothing leaves the server until the person confirms. The editor then reads the job until it
 * settles and adds the lines to that clip itself. Jobs are remembered per project, so captions that
 * were paid for still arrive after a reload.
 */
export type StudioCloudCaptionAnchor = { fromSeconds: number; sourceStartSeconds: number; speed: number };

export type StudioCloudCaptionRequest = { clipId: string; language: string; name: string };

/** `anchor` is where the clip sits in the priced revision: the server's cues are in that revision's timeline seconds. */
export type StudioCloudCaptionJob = StudioCloudCaptionRequest & { id: string; anchor: StudioCloudCaptionAnchor };

export type StudioCloudCaptionCue = { start: number; end: number; text: string };

export type StudioCloudCaptionState = {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  cues: StudioCloudCaptionCue[];
};

const CLIP_ID = /^[\w-]{1,128}$/;
const JOB_ID = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const LANGUAGE = /^[A-Za-z0-9-]{2,35}$/;
const MAX_NAME = 512;
const SETTLED = ['completed', 'failed', 'cancelled'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAnchor = (value: unknown): value is StudioCloudCaptionAnchor =>
  isRecord(value) &&
  Number.isFinite(value.fromSeconds) &&
  (value.fromSeconds as number) >= 0 &&
  Number.isFinite(value.sourceStartSeconds) &&
  (value.sourceStartSeconds as number) >= 0 &&
  Number.isFinite(value.speed) &&
  (value.speed as number) > 0;

export const isStudioCloudCaptionId = (value: unknown): value is string =>
  typeof value === 'string' && JOB_ID.test(value);

export const isStudioCloudCaptionRequest = (value: unknown): value is StudioCloudCaptionRequest =>
  isRecord(value) &&
  typeof value.clipId === 'string' &&
  CLIP_ID.test(value.clipId) &&
  typeof value.language === 'string' &&
  LANGUAGE.test(value.language) &&
  typeof value.name === 'string' &&
  value.name.length <= MAX_NAME;

const isJob = (value: unknown): value is StudioCloudCaptionJob =>
  isStudioCloudCaptionRequest(value) &&
  isStudioCloudCaptionId((value as StudioCloudCaptionJob).id) &&
  isAnchor((value as StudioCloudCaptionJob).anchor);

const numberOr = (value: unknown, fallback: number) => (value === undefined ? fallback : value);

/** Where a clip sits in a saved graph, read the way the server reads it to transcribe that revision. */
export const clipAnchorIn = (graph: unknown, clipId: string): StudioCloudCaptionAnchor | null => {
  if (!isRecord(graph) || !isRecord(graph.metadata) || !isRecord(graph.timeline)) {
    return null;
  }
  const items: unknown[] = Array.isArray(graph.timeline.items) ? graph.timeline.items : [];
  const clip = items.find((item) => isRecord(item) && item.id === clipId);
  const { fps } = graph.metadata;
  if (!isRecord(clip) || typeof fps !== 'number' || fps <= 0 || typeof clip.from !== 'number') {
    return null;
  }
  const sourceFps = numberOr(clip.sourceFps, fps) as number;
  const anchor = {
    fromSeconds: clip.from / fps,
    sourceStartSeconds: (numberOr(clip.sourceStart, 0) as number) / sourceFps,
    speed: numberOr(clip.speed, 1) as number,
  };
  return sourceFps > 0 && isAnchor(anchor) ? anchor : null;
};

type Transcription = {
  status: string;
  error: string | null;
  result?: { cues: Array<{ start: Rational; end: Rational; text: string }> } | null;
};
type Rational = { num: number; den: number };

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const createCloudCaptionServices = ({
  projectId,
  save,
  graph,
  confirm,
  read,
  storage = localStorage,
}: {
  /** Read on each use: a draft's first save and Save as copy both change it without a remount. */
  projectId: () => string;
  /** The server prices the head revision, so unsaved edits must land first. */
  save: () => Promise<unknown>;
  /** The saved graph once `save` has settled: the revision the server prices. */
  graph: () => unknown;
  /** Show the price. Resolves with the confirmed job's id, or null when nothing was sent. */
  confirm: (request: StudioCloudCaptionRequest) => Promise<string | null>;
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
      await save();
      // From the saved revision, not the editor: its newest edit may not have been saved yet.
      const anchor = clipAnchorIn(graph(), request.clipId);
      if (!anchor) {
        throw new Error('CLOUD_CAPTIONS_CLIP_NOT_SAVED');
      }
      const id = await confirm(request);
      if (!id) {
        return null;
      }
      const job = { ...request, id, anchor };
      const project = projectId();
      owners.set(id, project);
      remember(project, [...pending(project), job]);
      return job;
    },

    readCloudCaptions: async (id: string): Promise<StudioCloudCaptionState> => {
      const project = owners.get(id) ?? projectId();
      const transcription = await read(project, id);
      const settled = SETTLED.find((value) => value === transcription.status) ?? 'running';
      // A completed job always carries its result; without one there is nothing to add.
      const status = settled === 'completed' && !transcription.result ? 'failed' : settled;
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
