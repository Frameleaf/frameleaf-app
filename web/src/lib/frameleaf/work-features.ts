import { QueueName } from '@frameleaf/sdk';
import {
  mdiAccountMultipleOutline,
  mdiBroom,
  mdiClosedCaptionOutline,
  mdiImageMultipleOutline,
  mdiImageSearchOutline,
  mdiMovieEditOutline,
  mdiTagTextOutline,
  mdiTextRecognition,
} from '@mdi/js';

/**
 * The eight features people see in Settings › Background work › Everyday (approved design,
 * 2026-11-04, prototype `work-v3.mjs` `FEATURES`). Each is a group of the server's own tasks; Advanced
 * shows those tasks one by one. Transcripts and Studio export run as jobs a person starts, so they have
 * no task of their own here. Upkeep takes every task not named elsewhere, so a new task always has a home.
 */
export type WorkFeatureId =
  'ready' | 'faces' | 'search' | 'text' | 'descriptions' | 'transcripts' | 'export' | 'upkeep';

export type WorkFeature = {
  id: WorkFeatureId;
  icon: string;
  /** Where its work runs is chosen in Computers (the who-does-what grid). */
  routed: boolean;
  queues: readonly QueueName[];
};

const NAMED: Record<Exclude<WorkFeatureId, 'upkeep'>, readonly QueueName[]> = {
  ready: [
    QueueName.ThumbnailGeneration,
    QueueName.MetadataExtraction,
    QueueName.VideoConversion,
    QueueName.Sidecar,
    QueueName.Library,
    QueueName.Editor,
  ],
  faces: [QueueName.FaceDetection, QueueName.FacialRecognition, QueueName.PetRecognition],
  search: [QueueName.SmartSearch, QueueName.Search],
  text: [QueueName.Ocr],
  descriptions: [QueueName.ImageDescription, QueueName.ImageEnrichment, QueueName.NsfwDetection],
  transcripts: [],
  export: [],
};
const named = new Set(Object.values(NAMED).flat());

export const WORK_FEATURES: readonly WorkFeature[] = [
  { id: 'ready', icon: mdiImageMultipleOutline, routed: false, queues: NAMED.ready },
  { id: 'faces', icon: mdiAccountMultipleOutline, routed: true, queues: NAMED.faces },
  { id: 'search', icon: mdiImageSearchOutline, routed: true, queues: NAMED.search },
  { id: 'text', icon: mdiTextRecognition, routed: true, queues: NAMED.text },
  { id: 'descriptions', icon: mdiTagTextOutline, routed: true, queues: NAMED.descriptions },
  { id: 'transcripts', icon: mdiClosedCaptionOutline, routed: true, queues: [] },
  { id: 'export', icon: mdiMovieEditOutline, routed: true, queues: [] },
  {
    id: 'upkeep',
    icon: mdiBroom,
    routed: false,
    queues: Object.values(QueueName).filter((name) => !named.has(name)),
  },
];

export const workFeature = (id: string | null | undefined) => WORK_FEATURES.find((feature) => feature.id === id);

/** The feature a server task belongs to. */
export const featureOfQueue = (name: QueueName) =>
  WORK_FEATURES.find((feature) => feature.queues.includes(name)) as WorkFeature;
