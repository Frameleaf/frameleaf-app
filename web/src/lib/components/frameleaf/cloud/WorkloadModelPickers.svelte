<script lang="ts">
  /**
   * The model sliders for one kind of work on its feature page (FL-186, FL-189; prototype
   * WorkloadRouting.jsx `DefaultModelSlider` and `settings-v2/care/ai-models.jsx`). One slider per model
   * group: restoration has one for faithful and one for creative, and Studio AI one for speech to text
   * and one for voice-over.
   *
   * Descriptions also has this server's model on the same slider (white and green stops), written to
   * `machineLearning.imageDescription.modelName` in the settings draft and saved with the settings
   * bar. Restoration and Smooth motion show what connected computers report they can run (`homeReports`)
   * as green stops, chosen when a job starts because no setting keeps a default for them. Upscale and
   * Studio AI have no local model to show, so their sliders have the blue band only. A Frameleaf Cloud
   * choice is kept apart from the workload's route, so it applies to every cloud job of the group, and
   * moving a route never changes it. Blue stops are offered whatever the route, which is only a preference.
   */
  import ModelGroupPicker from '$lib/components/frameleaf/cloud/ModelGroupPicker.svelte';
  import { workloadNameKey, type RoutedWorkload } from '$lib/frameleaf/cloud-ml';
  import { catalogModelsFor, cloudModelGroupsFor, type CloudModelChoices } from '$lib/frameleaf/cloud-models';
  import type { RouteMode } from '$lib/frameleaf/gpu-model-catalog';
  import { homeStops, localHardware, localModelsFor, localStops, type LocalSide } from '$lib/frameleaf/local-models';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import {
    CloudMlModelGroup,
    type CloudMlModelChoiceDto,
    type CloudMlModelDto,
    type HardwareCheckResponseDto,
    type MlRestorationModelsResponseDto,
  } from '@frameleaf/sdk';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    row: RoutedWorkload;
    route: RouteMode;
    /** The stored Hardware & GPU check, or null when there is none. */
    hardware: HardwareCheckResponseDto | null;
    /** The catalogue's models, or null while it is being read, when it could not be, or with cloud off. */
    catalog: CloudMlModelDto[] | null;
    catalogFailed: boolean;
    choices: CloudModelChoices;
    /** The name of the slider, where a kind of work has one and its page has a better word for it. */
    legend?: string;
    /** What connected computers report they can run; empty or left out shows no green stops for that work. */
    homeReports?: readonly Pick<MlRestorationModelsResponseDto, 'reachable' | 'models'>[];
    /** Frameleaf Cloud's list can't be read yet (not linked): one blue stop stands for it. */
    cloudPlaceholder?: boolean;
    /** Frameleaf Cloud can take work now; while it can't, a blue stop also calls `onNeedsCloud`. */
    cloudSetUp?: boolean;
    /** A blue stop was picked while Frameleaf Cloud isn't set up: open whatever sets it up. */
    onNeedsCloud?: () => void;
    onSaved: (choices: CloudMlModelChoiceDto[], message: string) => void;
  };

  let {
    row,
    route,
    hardware,
    catalog,
    catalogFailed,
    choices,
    legend,
    homeReports = [],
    cloudPlaceholder = false,
    cloudSetUp,
    onNeedsCloud,
    onSaved,
  }: Props = $props();

  const groups = $derived(cloudModelGroupsFor(row));
  const localModels = $derived(localModelsFor(row));

  const settingsDraft = getSystemConfigDraft();
  const imageDescription = $derived(settingsDraft?.draft.machineLearning?.imageDescription);
  const savedImageDescription = $derived(settingsDraft?.baseline.machineLearning?.imageDescription);

  /** This server's side: descriptions only, while the settings draft holds its model setting. */
  const local = $derived.by((): LocalSide | null => {
    const draft = imageDescription;
    if (localModels.length === 0 || !draft) {
      return null;
    }
    const localHw = localHardware(hardware);
    return {
      stops: localStops(localModels, localHw, route),
      value: draft.modelName,
      saved: savedImageDescription?.modelName ?? draft.modelName,
      hardware: localHw,
      disabled: featureFlagsManager.value.configFile,
      onChoose: (value) => {
        draft.modelName = value;
      },
    };
  });

  const cloudReason = $derived(route === 'local' ? $t('frameleaf_model_reason_local_only') : '');

  /** A group with no local model setting shows what connected computers report, read-only. */
  const homeSide = (group: CloudMlModelGroup): LocalSide | null => {
    const stops = homeStops(homeReports, group);
    return stops.length > 0
      ? {
          stops,
          value: '',
          saved: '',
          hardware: localHardware(hardware),
          disabled: false,
          readOnly: true,
          onChoose: () => {},
        }
      : null;
  };

  /** The name of each slider: the kind of work, or its mode or feature when it has more than one. */
  const groupName = (group: CloudMlModelGroup): Translations => {
    switch (group) {
      case CloudMlModelGroup.RestorationFaithful: {
        return 'admin.frameleaf_cloud_model_group_restoration_faithful';
      }
      case CloudMlModelGroup.RestorationCreative: {
        return 'admin.frameleaf_cloud_model_group_restoration_creative';
      }
      case CloudMlModelGroup.Transcription: {
        return 'admin.frameleaf_cloud_model_group_transcription';
      }
      case CloudMlModelGroup.Tts: {
        return 'admin.frameleaf_cloud_model_group_tts';
      }
      default: {
        return workloadNameKey(row);
      }
    }
  };
</script>

{#each groups as { group }, index (group)}
  {@const groupLocal = index === 0 && local ? local : homeSide(group)}
  {#if groupLocal || catalog || cloudPlaceholder}
    {@const name = $t(groupName(group))}
    <ModelGroupPicker
      {group}
      legend={groups.length === 1 && legend ? legend : name}
      {name}
      models={catalog ? catalogModelsFor(catalog, group) : null}
      {cloudReason}
      modelId={choices[group] ?? null}
      local={groupLocal}
      workerNote={localModels.length === 0 && !groupLocal}
      {cloudPlaceholder}
      {cloudSetUp}
      {onNeedsCloud}
      {onSaved}
    />
  {/if}
{/each}
{#if catalogFailed}
  <p class="fc-routing-summary is-warning" role="status">{$t('admin.frameleaf_cloud_model_catalog_error')}</p>
{/if}
