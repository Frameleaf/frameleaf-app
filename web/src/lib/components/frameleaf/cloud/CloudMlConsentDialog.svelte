<script lang="ts">
  /**
   * Cloud processing terms (FL-159, handoff §3.1; prototype FrameleafCloud.jsx `ConsentDialog`): the
   * version Frameleaf Cloud requires now, the five promises (previews only with metadata stripped,
   * zero retention, no training, the account's region, nothing without confirmation), faces never
   * sent, and the optional features, which stay off unless chosen (names written in a photo, medical
   * signals; the names people are given here are never sent, FC-44). "Accept and turn on" stays disabled until the terms are marked as read. Accepting
   * records the version on this server and with Frameleaf Cloud; when the Frameleaf Cloud destination
   * does not exist yet it is added first, and it still runs only the work routed to it. FC-62: the
   * terms shown are the ones Frameleaf Cloud asks for with the features chosen now, read each time they
   * change; accepting sends that version and its text digest, and terms that changed meanwhile are
   * read again and shown, never accepted unseen.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { CONSENT_TERM_KEYS } from '$lib/frameleaf/cloud-ml';
  import { FRAMELEAF_CLOUD_WORKLOADS } from '$lib/frameleaf/ml-destinations';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createCloudMlDestination,
    getCloudMlConsentTerms,
    grantMlDestinationConsent,
    isHttpError,
    type CloudMlConsentStateDto,
    type CloudMlConsentTermsDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiOpenInNew, mdiShieldCheckOutline } from '@mdi/js';
  import { untrack } from 'svelte';
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
  /**
   * FC-62: the terms Frameleaf Cloud asks for with the features chosen now, read from the cloud each
   * time the choices change. Only these are accepted: their version and the digest of their text.
   */
  let terms = $state<CloudMlConsentTermsDto | null>(null);
  let termsChanged = $state(false);
  let termsTurn = 0;

  const shown = $derived({
    version: terms?.requiredVersion ?? consent.requiredVersion,
    summary: terms ? terms.summary : consent.summary,
    documentUrl: terms ? terms.documentUrl : consent.documentUrl,
  });

  const loadTerms = async (names: boolean, medical: boolean) => {
    const turn = ++termsTurn;
    try {
      const next = await getCloudMlConsentTerms({ identityNames: names, medicalSignals: medical });
      if (turn !== termsTurn) {
        return;
      }
      if (terms && (next.requiredVersion !== terms.requiredVersion || next.textSha256 !== terms.textSha256)) {
        // other terms than the ones read: they have to be read again
        read = false;
      }
      terms = next;
    } catch (error) {
      if (turn === termsTurn) {
        terms = null;
        handleError(error, $t('admin.frameleaf_cloud_ml_consent_error'));
      }
    }
  };

  // Every opening starts from the choices on record, with the terms not yet marked as read.
  $effect(() => {
    if (!open) {
      return;
    }
    untrack(() => {
      identityNames = consent.features.identityNames;
      medicalSignals = consent.features.medicalSignals;
      read = false;
      terms = null;
      termsChanged = false;
    });
  });

  // The terms follow the features chosen.
  $effect(() => {
    if (!open) {
      return;
    }
    const names = identityNames;
    const medical = medicalSignals;
    untrack(() => void loadTerms(names, medical));
  });

  const accept = async () => {
    if (!read || !terms) {
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
          version: terms.requiredVersion,
          ...(terms.textSha256 && { textSha256: terms.textSha256 }),
          features: { identityNames, medicalSignals, ocrAddon: false },
        },
      });
      open = false;
      onRecorded?.();
    } catch (error) {
      if (isHttpError(error) && (error.data as { code?: unknown } | undefined)?.code === 'consent-version-outdated') {
        // FC-62: Frameleaf Cloud asks for other terms now: read them for the same features and show them;
        // the version it named is never accepted unseen
        termsChanged = true;
        read = false;
        await loadTerms(identityNames, medicalSignals);
        return;
      }
      handleError(error, $t('admin.frameleaf_cloud_ml_consent_error'));
    } finally {
      saving = false;
    }
  };
</script>

<Dialog
  title={$t('admin.frameleaf_cloud_ml_consent_title', { values: { version: shown.version } })}
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
    {#if termsChanged}
      <p class="fc-muted" role="status">{$t('admin.frameleaf_cloud_ml_consent_terms_changed')}</p>
    {/if}
    {#if shown.summary}
      <p class="fc-muted">{shown.summary}</p>
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
    {#if shown.documentUrl}
      <a class="fc-link" href={shown.documentUrl} target="_blank" rel="noopener noreferrer">
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
    <Button variant="primary" onclick={accept} disabled={!read || !terms || saving}>
      {$t('admin.frameleaf_cloud_ml_consent_accept')}
    </Button>
  {/snippet}
</Dialog>
