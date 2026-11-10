import type {
  AssetTypeEnum,
  AssetVisibility,
  TagResponseDto,
  WorkflowType,
} from '@frameleaf/sdk';

type DeepPartial<T> = T extends Date
  ? T
  : T extends Record<string, unknown>
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T extends Array<infer R>
      ? DeepPartial<R>[]
      : T;

/**
 * FL-819: the event types a step can run on. `EventV1` (a Frameleaf event, such as a finished Studio
 * export) is not in the published `WorkflowType` enum, whose closed list older native apps decode, so
 * it is named here as a plain string.
 */
export type WorkflowEventType = `${WorkflowType}` | 'EventV1';

export type WorkflowEventMap = {
  AssetV1: AssetV1;
  EventV1: EventV1;
  // [WorkflowType.AssetPersonV1]: AssetPersonV1;
} & { [K in WorkflowEventType]: unknown };

export type WorkflowEventData<T extends WorkflowEventType> = WorkflowEventMap[T];

export enum WorkflowTrigger {
  AssetCreate = 'AssetCreate',
  AssetChanged = 'AssetChanged',
  Schedule = 'Schedule',
  AssetMetadataExtraction = 'AssetMetadataExtraction',
  AssetTagged = 'AssetTagged',
  // PersonRecognized = 'PersonRecognized',
  // FL-819: Frameleaf events. They run `EventV1` steps (only the webhook) and are listed by the
  // automation discovery endpoint in `eventTriggers`, never in the published `WorkflowTrigger` enum.
  StudioExportCompleted = 'StudioExportCompleted',
  CloudBackupCompleted = 'CloudBackupCompleted',
  CloudBackupFailed = 'CloudBackupFailed',
  ClientsGalleryApproved = 'ClientsGalleryApproved',
  CloudJobCompleted = 'CloudJobCompleted',
}

/** FL-819: the triggers that are Frameleaf events rather than something that happened to a photo. */
export const FRAMELEAF_EVENT_TRIGGERS = [
  WorkflowTrigger.StudioExportCompleted,
  WorkflowTrigger.CloudBackupCompleted,
  WorkflowTrigger.CloudBackupFailed,
  WorkflowTrigger.ClientsGalleryApproved,
  WorkflowTrigger.CloudJobCompleted,
] as const;

export type FrameleafEventTrigger = (typeof FRAMELEAF_EVENT_TRIGGERS)[number];

export type WorkflowEventPayload<
  T extends WorkflowEventType,
  TConfig = WorkflowStepConfig,
> = {
  trigger: WorkflowTrigger;
  type: T;
  data: WorkflowEventData<T>;
  config: TConfig;
  workflow: {
    id: string;
    authToken: string;
    stepId: string;
    debug?: boolean;
  };
};

export type WorkflowChanges<T extends WorkflowEventType> = DeepPartial<
  WorkflowEventData<T>
>;

export type WorkflowResponse<T extends WorkflowEventType> = {
  workflow?: {
    /** stop the workflow */
    continue?: boolean;
  };
  changes?: WorkflowChanges<T>;
  /** data to be passed to the next workflow step */
  data?: Record<string, unknown>;
  /** update step config */
  config?: WorkflowStepConfig;
};

export type WorkflowStepConfig = {
  [key: string]: ConfigValue;
};

export type ConfigValue =
  | string
  | number
  | boolean
  | null
  | ConfigValue[]
  | { [key: string]: ConfigValue };

export type AssetV1 = {
  asset: {
    id: string;
    ownerId: string;
    type: AssetTypeEnum;
    originalPath: string;
    fileCreatedAt: string;
    fileModifiedAt: string;
    isFavorite: boolean;
    checksum: Buffer; // sha1 checksum
    livePhotoVideoId: string | null;
    updatedAt: string;
    createdAt: string;
    originalFileName: string;
    isOffline: boolean;
    libraryId: string | null;
    isExternal: boolean;
    deletedAt: string | null;
    localDateTime: string;
    stackId: string | null;
    duplicateId: string | null;
    visibility: AssetVisibility;
    isEdited: boolean;
    tags: TagResponseDto[];
    exifInfo: {
      make: string | null;
      model: string | null;
      exifImageWidth: number | null;
      exifImageHeight: number | null;
      fileSizeInByte: number | null;
      orientation: string | null;
      dateTimeOriginal: string | null;
      modifyDate: string | null;
      lensModel: string | null;
      fNumber: number | null;
      focalLength: number | null;
      iso: number | null;
      latitude: number | null;
      longitude: number | null;
      city: string | null;
      state: string | null;
      country: string | null;
      description: string | null;
      fps: number | null;
      exposureTime: string | null;
      livePhotoCID: string | null;
      timeZone: string | null;
      projectionType: string | null;
      profileDescription: string | null;
      colorspace: string | null;
      bitsPerSample: number | null;
      autoStackId: string | null;
      rating: number | null;
      tags: string[] | null;
      updatedAt: string | null;
    } | null;
  };
};

/**
 * FL-819: what a Frameleaf event sends. Each event lists its own `detail` fields; none names a Locked
 * or hidden photo, another account's data, a file path or a credential.
 */
export type EventV1 = {
  /** The event name, for example `cloud.backup.failed`. */
  event: string;
  /** Stable for one occurrence: a receiver can ignore a second delivery with the same id. */
  deliveryId: string;
  occurredAt: string;
  subject: { kind: string; id: string; name: string | null };
  detail: Record<string, string | number | boolean | null>;
};

// export type AssetPersonV1 = AssetV1 & {
//   person: {
//     id: string;
//     name: string;
//   };
// };
