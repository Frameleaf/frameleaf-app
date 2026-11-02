/**
 * Cut out the subject (FL-639), as the host offers it to the editor.
 *
 * The editor's cut-out card asks who it can follow in a clip, starts a cut-out and reads it until it
 * settles, through the three host services below. They carry data only; the server decides access
 * (owner only, the clip on the head revision, locked media refused) and where the work runs (this server
 * or a computer at home, never Frameleaf Cloud). Once a cut-out completes, its matte is a project file:
 * the host reloads the project's files before it answers, so the editor can draw the clip with it.
 */
export type StudioCutoutSubjectRef = { kind: 'person' | 'subject'; personId: string | null; name: string | null };

export type StudioCutoutPoint = { sourceSeconds: number; x: number; y: number; label: 0 | 1 };

export type StudioCutoutRequest = { clipId: string; personId: string | null; points: StudioCutoutPoint[] };

export type StudioCutoutMatte = {
  importId: string;
  startSeconds: number;
  durationSeconds: number;
  fps: number;
  frames: number;
  columns: number;
  frameWidth: number;
  frameHeight: number;
};

export type StudioCutoutState = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  error: string | null;
  /** A refusal the editor words itself: `faceDetectionOff` or `personNotInFirstFrame`. */
  errorCode: string | null;
  matte: StudioCutoutMatte | null;
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const fraction = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** A clip id as the editor names it. */
export const isStudioCutoutClipId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;

export const isStudioCutoutId = uuid;

/** Exactly the request the server takes, so nothing else reaches it from the frame. */
export const isStudioCutoutRequest = (value: unknown): value is StudioCutoutRequest =>
  record(value) &&
  Object.keys(value).every((key) => ['clipId', 'personId', 'points'].includes(key)) &&
  isStudioCutoutClipId(value.clipId) &&
  (value.personId === null || uuid(value.personId)) &&
  Array.isArray(value.points) &&
  value.points.length <= 64 &&
  value.points.every(
    (point) =>
      record(point) &&
      typeof point.sourceSeconds === 'number' &&
      Number.isFinite(point.sourceSeconds) &&
      point.sourceSeconds >= 0 &&
      fraction(point.x) &&
      fraction(point.y) &&
      (point.label === 0 || point.label === 1),
  );

type CutoutDto = {
  id: string;
  status: StudioCutoutState['status'];
  progress: number;
  error?: string | null;
  errorCode?: string | null;
  matte?: StudioCutoutMatte | null;
};

/** The server's cut-out as the editor reads it. */
export const toStudioCutoutState = (dto: CutoutDto): StudioCutoutState => ({
  id: dto.id,
  status: dto.status,
  progress: dto.progress,
  error: dto.error ?? null,
  errorCode: dto.errorCode ?? null,
  matte: dto.matte
    ? {
        importId: dto.matte.importId,
        startSeconds: dto.matte.startSeconds,
        durationSeconds: dto.matte.durationSeconds,
        fps: dto.matte.fps,
        frames: dto.matte.frames,
        columns: dto.matte.columns,
        frameWidth: dto.matte.frameWidth,
        frameHeight: dto.matte.frameHeight,
      }
    : null,
});

export type StudioCutoutApi = {
  subjects: (projectId: string, clipId: string) => Promise<{ subjects: StudioCutoutSubjectRef[] }>;
  create: (projectId: string, request: StudioCutoutRequest) => Promise<CutoutDto>;
  get: (projectId: string, cutoutId: string) => Promise<CutoutDto>;
};

/**
 * The host's three cut-out services for one project. `matteKept` reloads the project's files once a
 * cut-out completes, before the editor hears that it has.
 */
export function createStudioCutoutServices(options: {
  projectId: () => string;
  api: StudioCutoutApi;
  matteKept: () => Promise<void>;
}) {
  const { api } = options;
  return {
    listCutoutSubjects: async (clipId: string): Promise<StudioCutoutSubjectRef[]> =>
      (await api.subjects(options.projectId(), clipId)).subjects.map((subject) => ({
        kind: subject.kind,
        personId: subject.personId ?? null,
        name: subject.name ?? null,
      })),
    startCutout: async (request: StudioCutoutRequest): Promise<StudioCutoutState> =>
      toStudioCutoutState(await api.create(options.projectId(), request)),
    readCutout: async (cutoutId: string): Promise<StudioCutoutState> => {
      const state = toStudioCutoutState(await api.get(options.projectId(), cutoutId));
      if (state.status === 'completed') {
        await options.matteKept();
      }
      return state;
    },
  };
}
