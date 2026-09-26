<script lang="ts">
  /**
   * The model sliders for one kind of work in Where each job runs and on the Cloud processing page's
   * Models card (FL-186, FL-189; prototype WorkloadRouting.jsx `DefaultModelSlider`). One slider per
   * model group: restoration has one for faithful and one for creative, and Studio AI one for speech
   * to text and captions and one for speech.
   *
   * Descriptions also has this server's model on the same slider (white and green stops), written to
   * `machineLearning.imageDescription.modelName` in the settings draft and saved with the settings
   * bar. The other kinds of work have no local model setting (upscale and smooth motion have no local
   * runner; restoration and Studio AI workers bring their own models), so their sliders have the blue
   * band only. A Frameleaf Cloud choice is kept apart from the workload's route, so it applies to
   * every cloud job of the group, including a "Both" workload routed to this server, and moving a
   * route never changes it. Work set to Local only keeps its blue stops, crossed out with the reason,
   * and work set to Cloud only its local stops.
   */
  import ModelGroupPicker from '$lib/components/frameleaf/cloud/ModelGroupPicker.svelte';
  import { workloadNameKey, type RoutedWorkload } from '$lib/frameleaf/cloud-ml';
  import { catalogModelsFor, cloudModelGroupsFor, type CloudModelChoices } from '$lib/frameleaf/cloud-models';
  import type { RouteMode } from '$lib/frameleaf/gpu-model-catalog';
  import { localHardware, localModelsFor, localStops, type LocalSide } from '$lib/frameleaf/local-models';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import {
    CloudMlModelGroup,
    type CloudMlModelChoiceDto,
    type CloudMlModelDto,
    type HardwareCheckResponseDto,
  } from '@immich/sdk';
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
    /** "Model for …" in Where each job runs; the name of the work alone on the Models card. */
    modelForLegend?: boolean;
    onSaved: (choices: CloudMlModelChoiceDto[], message: string) => void;
  };

  let { row, route, hardware, catalog, catalogFailed, choices, modelForLegend = true, onSaved }: Props = $props();

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

  /** The name of each slider: the kind of work, or its mode or feature when it has more than one. */
  const groupName = (group: CloudMlModelGroup): Translations => {
    switch (group) {
      case CloudMlModelGroup.RestorationFaithful: {
        return 'admin.frameleaf_ml_workload_restoration_faithful';
      }
      case CloudMlModelGroup.RestorationCreative: {
        return 'admin.frameleaf_ml_workload_restoration_creative';
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

  const legendFor = (name: string) =>
    modelForLegend ? $t('admin.frameleaf_model_for', { values: { name: name.toLocaleLowerCase() } }) : name;
</script>

{#each groups as { group }, index (group)}
  {@const groupLocal = index === 0 ? local : null}
  {#if groupLocal || catalog}
    {@const name = $t(groupName(group))}
    <ModelGroupPicker
      {group}
      legend={legendFor(name)}
      {name}
      models={catalog ? catalogModelsFor(catalog, group) : null}
      {cloudReason}
      modelId={choices[group] ?? null}
      local={groupLocal}
      workerNote={localModels.length === 0}
      {onSaved}
    />
  {/if}
{/each}
{#if catalogFailed}
  <p class="fc-routing-summary is-warning" role="status">{$t('admin.frameleaf_cloud_model_catalog_error')}</p>
{/if}
