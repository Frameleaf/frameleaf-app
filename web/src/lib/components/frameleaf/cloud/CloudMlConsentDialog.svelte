<script lang="ts">
  /**
   * Frameleaf Cloud consent (FL-159): the prototype's `ProviderReview` (JobsManager.jsx:1761-1800),
   * a sheet that says what will happen and cannot be confirmed until the administrator ticks the
   * acknowledgement (`.jm-confirm`). It records the version Frameleaf Cloud requires now, with a
   * choice for each optional feature; every feature is off unless chosen, so names and medical
   * signals never reach a cloud prompt by default. The server refuses a version that is not the
   * current one, so an outdated sheet cannot be accepted.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { grantMlDestinationConsent, type CloudMlConsentFeaturesDto, type CloudMlConsentStateDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiOpenInNew } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    open?: boolean;
    destinationId: string;
    consent: CloudMlConsentStateDto;
    onRecorded?: () => void;
  };

  let { open = $bindable(false), destinationId, consent, onRecorded }: Props = $props();

  const FEATURES: ReadonlyArray<{ key: keyof CloudMlConsentFeaturesDto; label: Translations; help: Translations }> = [
    {
      key: 'identityNames',
      label: 'admin.frameleaf_cloud_ml_consent_feature_names',
      help: 'admin.frameleaf_cloud_ml_consent_feature_names_help',
    },
    {
      key: 'medicalSignals',
      label: 'admin.frameleaf_cloud_ml_consent_feature_medical',
      help: 'admin.frameleaf_cloud_ml_consent_feature_medical_help',
    },
    {
      key: 'ocrAddon',
      label: 'admin.frameleaf_cloud_ml_consent_feature_ocr',
      help: 'admin.frameleaf_cloud_ml_consent_feature_ocr_help',
    },
  ];

  let features = $state<CloudMlConsentFeaturesDto>({ identityNames: false, medicalSignals: false, ocrAddon: false });
  let acknowledged = $state(false);
  let saving = $state(false);

  // Every opening starts from the choices on record for the version being renewed, never ticked.
  $effect(() => {
    if (open) {
      features = { ...consent.features };
      acknowledged = false;
    }
  });

  const record = async () => {
    if (!acknowledged) {
      return;
    }
    saving = true;
    try {
      await grantMlDestinationConsent({
        id: destinationId,
        mlDestinationConsentRequestDto: {
          acknowledgeMediaLeavesNetwork: true,
          version: consent.requiredVersion,
          features: { ...features },
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

<Dialog title={$t('admin.frameleaf_cloud_ml_consent_title')} closeLabel={$t('close')} bind:open>
  <div class="review">
    <p>{consent.summary}</p>
    <dl>
      <div>
        <dt>{$t('admin.frameleaf_cloud_ml_consent_version')}</dt>
        <dd>{consent.requiredVersion}</dd>
      </div>
      {#if consent.acceptedVersion}
        <div>
          <dt>{$t('admin.frameleaf_cloud_ml_consent_accepted_version')}</dt>
          <dd>{consent.acceptedVersion}</dd>
        </div>
      {/if}
    </dl>
    {#if consent.outdated}
      <p class="warning" role="status">{$t('admin.frameleaf_cloud_ml_consent_outdated')}</p>
    {/if}
    {#if consent.documentUrl}
      <a href={consent.documentUrl} target="_blank" rel="noopener noreferrer">
        {$t('admin.frameleaf_cloud_ml_consent_document')}
        <Icon icon={mdiOpenInNew} size="14" aria-hidden={true} />
      </a>
    {/if}
    <fieldset>
      <legend>{$t('admin.frameleaf_cloud_ml_consent_features')}</legend>
      {#each FEATURES as feature (feature.key)}
        <div class="feature">
          <div>
            <strong>{$t(feature.label)}</strong>
            <small>{$t(feature.help)}</small>
          </div>
          <Toggle
            label={$t(feature.label)}
            bind:checked={features[feature.key]}
            onLabel={$t('admin.frameleaf_cloud_ml_consent_feature_on')}
            offLabel={$t('admin.frameleaf_cloud_ml_consent_feature_off')}
            disabled={saving}
          />
        </div>
      {/each}
    </fieldset>
    <p class="muted">{$t('admin.frameleaf_cloud_ml_consent_scope')}</p>
    <label class="confirm">
      <input type="checkbox" bind:checked={acknowledged} disabled={saving} />
      {$t('admin.frameleaf_cloud_ml_consent_acknowledge')}
    </label>
  </div>
  {#snippet actions()}
    <Button onclick={() => (open = false)} disabled={saving}>{$t('cancel')}</Button>
    <Button variant="primary" onclick={record} disabled={!acknowledged || saving}>
      {$t('admin.frameleaf_cloud_ml_consent_action')}
    </Button>
  {/snippet}
</Dialog>

<style>
  /* jobs-manager.css:519-566 `.jm-review` and `.jm-confirm`. */
  .review {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: var(--fl-font-small);
    line-height: 1.6;
    color: var(--fl-text);
  }
  p {
    margin: 0;
  }
  dl {
    margin: 0;
  }
  dl > div {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    padding: 7px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  dt {
    color: var(--fl-muted);
  }
  dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fl-accent);
  }
  fieldset {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 8px 12px;
    margin: 0;
  }
  legend {
    padding-inline: 4px;
  }
  .feature {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
  }
  .feature + .feature {
    border-top: 1px solid var(--fl-border);
  }
  .feature strong,
  .feature small {
    display: block;
  }
  .feature small,
  .muted {
    color: var(--fl-muted);
  }
  .warning {
    color: var(--fl-warning);
  }
  .confirm {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 13px;
    background: color-mix(in srgb, var(--fl-danger) 8%, transparent);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .confirm input {
    margin-top: 5px;
    width: 16px;
    height: 16px;
    flex: none;
  }
</style>
