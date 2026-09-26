<script lang="ts">
  /**
   * The Frameleaf Cloud model pickers for one kind of work in Where each job runs and on the Cloud
   * processing page (FL-186). One picker per model group the kind of work covers: restoration has one
   * for faithful and one for creative, and Studio AI one for speech to text and captions and one for
   * speech. A choice is kept apart from the workload's route, so it applies to every cloud job of the
   * group, including a "Both" workload routed to this server, and moving a route never changes it.
   */
  import CloudModelPicker from '$lib/components/frameleaf/cloud/CloudModelPicker.svelte';
  import { workloadNameKey, type RoutedWorkload } from '$lib/frameleaf/cloud-ml';
  import { catalogModelsFor, cloudModelGroupsFor, type CloudModelChoices } from '$lib/frameleaf/cloud-models';
  import { CloudMlModelGroup, type CloudMlModelChoiceDto, type CloudMlModelDto } from '@immich/sdk';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    row: RoutedWorkload;
    /** The catalogue's models, or null while it is being read or when it could not be. */
    catalog: CloudMlModelDto[] | null;
    catalogFailed: boolean;
    choices: CloudModelChoices;
    onSaved: (choices: CloudMlModelChoiceDto[], message: string) => void;
  };

  let { row, catalog, catalogFailed, choices, onSaved }: Props = $props();

  const groups = $derived(cloudModelGroupsFor(row));

  /** The name of each picker: the kind of work, or its mode or feature when it has more than one. */
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
</script>

{#if catalogFailed}
  <p class="fc-routing-summary is-warning" role="status">{$t('admin.frameleaf_cloud_model_catalog_error')}</p>
{:else if catalog}
  {#each groups as { group } (group)}
    <CloudModelPicker
      {group}
      name={$t(groupName(group))}
      models={catalogModelsFor(catalog, group)}
      modelId={choices[group] ?? null}
      {onSaved}
    />
  {/each}
{/if}
