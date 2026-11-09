import {
  CloudRouteMode,
  getAdminConfigWithRevision,
  getCloudMlConsentTerms,
  createCloudMlDestination,
  grantMlDestinationConsent,
  isHttpError,
  updateAdminConfigWithRevision,
  type AdminConfigDto,
  type CloudMlConsentTermsDto,
  type CloudMlStatusResponseDto,
} from '@frameleaf/sdk';
import { ROUTED_WORKLOADS, type RoutedWorkload } from '$lib/frameleaf/cloud-ml';
import { forConfigSave } from '$lib/frameleaf/credentials';
import { FRAMELEAF_CLOUD_WORKLOADS } from '$lib/frameleaf/ml-destinations';

/**
 * Setting Frameleaf Cloud up from one place: what the Set up sheet and the Cloud processing page both do
 * when someone agrees to the terms or turns Cloud on. Each write is saved at once; none waits for the
 * settings bar. A settings page that holds a draft calls its `refresh()` afterwards.
 */
type CloudMl = NonNullable<AdminConfigDto['frameleafCloud']>['cloudMl'];

/** The optional features agreed to, as the terms ask for them. */
export type CloudConsentChoices = {
  identityNames: boolean;
  medicalSignals: boolean;
  smartSearch: boolean;
  faceRecognition: boolean;
};

export const loadCloudConsentTerms = (choices: CloudConsentChoices) =>
  getCloudMlConsentTerms({
    identityNames: choices.identityNames,
    medicalSignals: choices.medicalSignals,
    // FL-455: asked for only when chosen, so a Cloud without them answers as before
    ...(choices.smartSearch && { smartSearch: true }),
    ...(choices.faceRecognition && { faceRecognition: true }),
  });

/**
 * Records the agreement with Frameleaf Cloud and on this server, adding the Frameleaf Cloud destination
 * first when there is none yet. Accepts exactly the version and text digest that were shown.
 */
export const recordCloudConsent = async ({
  destinationId,
  terms,
  choices,
  onCreated,
}: {
  destinationId: string | null;
  terms: CloudMlConsentTermsDto;
  choices: CloudConsentChoices;
  /** The destination this just added, so a retry after a failed consent doesn't add it twice. */
  onCreated?: (id: string) => void;
}) => {
  let id = destinationId;
  if (!id) {
    ({ id } = await createCloudMlDestination({
      cloudMlDestinationCreateDto: { workloads: [...FRAMELEAF_CLOUD_WORKLOADS] },
    }));
    onCreated?.(id);
  }
  await grantMlDestinationConsent({
    id,
    mlDestinationConsentRequestDto: {
      acknowledgeMediaLeavesNetwork: true,
      version: terms.requiredVersion,
      ...(terms.textSha256 && { textSha256: terms.textSha256 }),
      features: {
        identityNames: choices.identityNames,
        medicalSignals: choices.medicalSignals,
        ocrAddon: false,
        ...(choices.smartSearch && { smartSearch: true }),
        ...(choices.faceRecognition && { faceRecognition: true }),
      },
    },
  });
  return id;
};

/** Terms that changed since they were read are read again and shown, never accepted unseen. */
export const isConsentOutdatedError = (error: unknown) =>
  isHttpError(error) && (error.data as { code?: unknown } | undefined)?.code === 'consent-version-outdated';

/** One saved change to the Cloud processing settings, against the newest settings on the server. */
const saveCloudMl = async (change: (cloudMl: CloudMl) => void) => {
  for (const lastTry of [false, true]) {
    const { config, revision } = await getAdminConfigWithRevision();
    change(config.frameleafCloud!.cloudMl);
    try {
      return await updateAdminConfigWithRevision({
        adminConfigRevisionUpdateDto: { config: forConfigSave(config), expectedRevision: revision },
      });
    } catch (error) {
      // someone else saved between the read and the write: their change is kept, and this one goes on top
      if (lastTry || !isHttpError(error) || error.status !== 409) {
        throw error;
      }
    }
  }
};

/**
 * Turns Cloud on now. The first time Cloud is turned on, kinds of work still set to this server become
 * Both, so Where work runs is only a preference from here on; work set to Frameleaf Cloud stays as it is.
 */
export const turnOnCloudProcessing = ({ firstTime }: { firstTime: boolean }) =>
  saveCloudMl((cloudMl) => {
    cloudMl.enabled = true;
    if (firstTime) {
      for (const row of ROUTED_WORKLOADS) {
        if ((cloudMl.routing[row] ?? CloudRouteMode.Local) === CloudRouteMode.Local) {
          cloudMl.routing[row] = CloudRouteMode.Both;
        }
      }
    }
  });

/** Cloud has never been agreed to on this server. */
export const isFirstCloudTurnOn = (status: Pick<CloudMlStatusResponseDto, 'consent' | 'destination'> | null) =>
  !status?.consent?.acceptedVersion && !status?.destination?.consent.acknowledgedAt;

/** Where work runs for one kind of work, saved at once: an administrator ran a blue stop on work kept at home. */
export const allowCloudFor = (row: RoutedWorkload) =>
  saveCloudMl((cloudMl) => {
    if ((cloudMl.routing[row] ?? CloudRouteMode.Local) === CloudRouteMode.Local) {
      cloudMl.routing[row] = CloudRouteMode.Both;
    }
  });
