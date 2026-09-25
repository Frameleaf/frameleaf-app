<script lang="ts">
  /**
   * Cloud processing terms (FL-159, handoff §3.1; prototype FrameleafCloud.jsx `ConsentDialog`): the
   * version Frameleaf Cloud requires now, the five promises (previews only with metadata stripped,
   * zero retention, no training, the account's region, nothing without confirmation), faces never
   * sent, and the optional features, which stay off unless chosen (recognised names, medical
   * signals). "Accept and turn on" stays disabled until the terms are marked as read. Accepting
   * records the version on this server and with Frameleaf Cloud; when the Frameleaf Cloud destination
   * does not exist yet it is added first, and it still runs only the work routed to it.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { CONSENT_TERM_KEYS } from '$lib/frameleaf/cloud-ml';
  import { FRAMELEAF_CLOUD_WORKLOADS } from '$lib/frameleaf/ml-destinations';
  import { handleError } from '$lib/utils/handle-error';
  import { createCloudMlDestination, grantMlDestinationConsent, type CloudMlConsentStateDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiOpenInNew, mdiShieldCheckOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    open?: boolean;
    /** The Frameleaf Cloud destination, or null when it has not been added yet. */
    destinationId: string | null;
    consent: CloudMlConsentStateDto;
    region: string | null;
    onRecorded?: () => void;
  };

  let { open = $bindable(false), destinationId, consent, region, onRecorded }: Props = $props();

  let identityNames = $state(false);
  let medicalSignals = $state(false);
  let read = $state(false);
  let saving = $state(false);
  // The destination this dialog added, kept so a retry after a failed consent does not add it twice.
  let createdId = $state<string | null>(null);

  // Every opening starts from the choices on record, with the terms not yet marked as read.
  $effect(() => {
    if (!open) {
      return;
    }
    identityNames = consent.features.identityNames;
    medicalSignals = consent.features.medicalSignals;
    read = false;
  });

  const accept = async () => {
    if (!read) {
      return;
    }
    saving = true;
    try {
      const id =
        destinationId ??
        createdId ??
        (createdId = (
          await createCloudMlDestination({
            cloudMlDestinationCreateDto: { workloads: [...FRAMELEAF_CLOUD_WORKLOADS] },
          })
        ).id);
      await grantMlDestinationConsent({
        id,
        mlDestinationConsentRequestDto: {
          acknowledgeMediaLeavesNetwork: true,
          version: consent.requiredVersion,
          features: { identityNames, medicalSignals, ocrAddon: false },
        },
      });
      open = false;
      onRecorded?.();
    } catch (error) {
      handleError(error, $t('admin.frameleaf_cloud_ml_consent_error'));
    } finally {
      saving = false;
    }
  };
</script>

<Dialog
  title={$t('admin.frameleaf_cloud_ml_consent_title', { values: { version: consent.requiredVersion } })}
  closeLabel={$t('close')}
  wide
  bind:open
>
  <div class="frameleaf-cloud fc-consent">
    <ul class="fc-terms">
      {#each CONSENT_TERM_KEYS as key (key)}
        <li><Icon icon={mdiShieldCheckOutline} size="16" aria-hidden={true} /> {$t(key)}</li>
      {/each}
    </ul>
    {#if consent.summary}
      <p class="fc-muted">{consent.summary}</p>
    {/if}
    <dl class="fc-facts">
      <dt>{$t('admin.frameleaf_cloud_ml_region_label')}</dt>
      <dd>
        {region
          ? $t('admin.frameleaf_cloud_ml_region_value', { values: { region } })
          : $t('admin.frameleaf_cloud_ml_region_unknown')}
      </dd>
      <dt>{$t('admin.frameleaf_cloud_ml_faces_label')}</dt>
      <dd>{$t('admin.frameleaf_cloud_ml_faces_never_sent')}</dd>
    </dl>
    {#if consent.documentUrl}
      <a class="fc-link" href={consent.documentUrl} target="_blank" rel="noopener noreferrer">
        {$t('admin.frameleaf_cloud_ml_consent_document')}
        <Icon icon={mdiOpenInNew} size="14" aria-hidden={true} />
      </a>
    {/if}
    <h3 class="fc-subhead">{$t('admin.frameleaf_cloud_ml_consent_features')}</h3>
    <SettingToggle
      title={$t('admin.frameleaf_cloud_ml_consent_feature_names')}
      subtitle={$t('admin.frameleaf_cloud_ml_consent_feature_names_help')}
      bind:checked={identityNames}
      disabled={saving}
    />
    <SettingToggle
      title={$t('admin.frameleaf_cloud_ml_consent_feature_medical')}
      subtitle={$t('admin.frameleaf_cloud_ml_consent_feature_medical_help')}
      bind:checked={medicalSignals}
      disabled={saving}
    />
    <label class="fc-confirm">
      <input type="checkbox" bind:checked={read} disabled={saving} />
      {$t('admin.frameleaf_cloud_ml_consent_read')}
    </label>
  </div>
  {#snippet actions()}
    <Button onclick={() => (open = false)} disabled={saving}>{$t('admin.frameleaf_cloud_ml_consent_not_now')}</Button>
    <Button variant="primary" onclick={accept} disabled={!read || saving}>
      {$t('admin.frameleaf_cloud_ml_consent_accept')}
    </Button>
  {/snippet}
</Dialog>
