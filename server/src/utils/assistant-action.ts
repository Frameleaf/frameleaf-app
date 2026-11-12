import z from 'zod';

/**
 * FL-938: the rules of an assistant action, kept free of the database and of NestJS so they can be
 * read and tested on their own: the write tools a planner may call, how long a change can be undone,
 * and which frames of a burst a cull keeps.
 */

/** How long an applied change can be undone. */
export const ASSISTANT_ACTION_UNDO_DAYS = 30;
/** How long a proposal waits for its confirmation before it expires. */
export const ASSISTANT_ACTION_PROPOSAL_HOURS = 24;
/** The most items one action may name. */
export const ASSISTANT_ACTION_MAX_ITEMS = 5000;
/** How many item ids a proposal or an undo report shows as a sample. */
export const ASSISTANT_ACTION_SAMPLE_SIZE = 12;
/** Photos with no camera burst id read as one burst when each follows the last within this long. */
export const ASSISTANT_BURST_GAP_MS = 2000;
/** The rating a culled frame is given ("Rejected"). */
export const ASSISTANT_REJECTED_RATING = -1;

export const AssistantActionStatus = {
  Proposed: 'proposed',
  Applied: 'applied',
  Undone: 'undone',
  Expired: 'expired',
} as const;

export const ASSISTANT_ACTION_TOOLS = ['create_album', 'add_to_album', 'tag', 'favourite', 'cull'] as const;
export type AssistantActionTool = (typeof ASSISTANT_ACTION_TOOLS)[number];

const name = (what: string) => z.string().trim().min(1).max(200).describe(what);

/**
 * The arguments of each write tool. Like `search_library`, albums and tags are names here and are
 * resolved to ids by the server, never by a model. Every tool acts on the items the person is looking
 * at, which the request names separately; no tool deletes or trashes anything.
 */
export const assistantActionToolArguments = {
  create_album: z.strictObject({
    name: name('Name of the new album'),
    description: z.string().trim().max(1000).optional().describe('Description of the new album'),
  }),
  add_to_album: z.strictObject({ album: name('The album to add the items to, by name') }),
  tag: z.strictObject({ tags: z.array(name('A tag, by name')).min(1).max(5).describe('Tags to put on the items') }),
  favourite: z.strictObject({}),
  cull: z.strictObject({}),
} satisfies Record<AssistantActionTool, z.ZodType>;

/** The JSON schema of each write tool's arguments, as a planner is told them. */
const toolSchema = (tool: AssistantActionTool): Record<string, unknown> =>
  z.toJSONSchema(assistantActionToolArguments[tool], { target: 'draft-2020-12' });
export const ASSISTANT_ACTION_TOOL_SCHEMAS: Record<AssistantActionTool, Record<string, unknown>> = {
  create_album: toolSchema('create_album'),
  add_to_album: toolSchema('add_to_album'),
  tag: toolSchema('tag'),
  favourite: toolSchema('favourite'),
  cull: toolSchema('cull'),
};

/** One photo a cull looks at. */
export type CullFrame = {
  id: string;
  takenAt: number;
  /** The camera's own burst id, when the file carries one. */
  burstId: string | null;
  /** The Best Photos score; null when the photo has not been scored. */
  score: number | null;
  isFavorite: boolean;
  rating: number | null;
};

export type CullPlan = {
  /** How many bursts hold something to reject. */
  bursts: number;
  /** The frames kept: the best of each burst, and every favourite or starred frame. */
  keepIds: string[];
  /** The frames to rate Rejected and archive. */
  rejectIds: string[];
  /** Frames of bursts where a frame has no Best Photos score yet, so no best could be chosen. */
  unscoredIds: string[];
  /** Frames that belong to no burst. */
  singleIds: string[];
};

/**
 * Group photos into bursts: frames sharing the camera's burst id, and, among the rest, runs of photos
 * each taken within `ASSISTANT_BURST_GAP_MS` of the one before. A group of one is not a burst.
 */
export const groupBursts = (frames: readonly CullFrame[]): CullFrame[][] => {
  const byTime = (a: CullFrame, b: CullFrame) => a.takenAt - b.takenAt || a.id.localeCompare(b.id);
  const groups: CullFrame[][] = [];
  const byBurstId = new Map<string, CullFrame[]>();
  const loose: CullFrame[] = [];
  for (const frame of frames) {
    if (frame.burstId) {
      byBurstId.set(frame.burstId, [...(byBurstId.get(frame.burstId) ?? []), frame]);
    } else {
      loose.push(frame);
    }
  }
  groups.push(...byBurstId.values());

  let run: CullFrame[] = [];
  for (const frame of loose.sort(byTime)) {
    const last = run.at(-1);
    if (last && frame.takenAt - last.takenAt > ASSISTANT_BURST_GAP_MS) {
      groups.push(run);
      run = [];
    }
    run.push(frame);
  }
  groups.push(run);

  return groups.filter((group) => group.length > 0).map((group) => group.sort(byTime));
};

/**
 * Which frames a cull keeps and which it rejects. The best of each burst is the frame with the highest
 * Best Photos score (the earliest wins a tie). A favourite or starred frame is never rejected: the
 * person already chose it. A burst with a frame that has no score yet is left alone rather than guessed at.
 */
export const planCull = (frames: readonly CullFrame[]): CullPlan => {
  const plan: CullPlan = { bursts: 0, keepIds: [], rejectIds: [], unscoredIds: [], singleIds: [] };
  for (const group of groupBursts(frames)) {
    if (group.length < 2) {
      plan.singleIds.push(...group.map(({ id }) => id));
      continue;
    }
    if (group.some((frame) => frame.score === null)) {
      plan.unscoredIds.push(...group.map(({ id }) => id));
      continue;
    }
    let best = group[0];
    for (const frame of group) {
      if ((frame.score as number) > (best.score as number)) {
        best = frame;
      }
    }
    const rejects = group.filter(
      (frame) => frame.id !== best.id && !frame.isFavorite && (frame.rating === null || !(frame.rating > 0)),
    );
    if (rejects.length === 0) {
      plan.singleIds.push(...group.map(({ id }) => id));
      continue;
    }
    const rejected = new Set(rejects.map(({ id }) => id));
    plan.bursts++;
    plan.rejectIds.push(...rejected);
    plan.keepIds.push(...group.filter(({ id }) => !rejected.has(id)).map(({ id }) => id));
  }
  return plan;
};

/** When an applied change can no longer be undone. */
export const assistantUndoExpiry = (appliedAt: Date): Date =>
  new Date(appliedAt.getTime() + ASSISTANT_ACTION_UNDO_DAYS * 24 * 60 * 60 * 1000);
