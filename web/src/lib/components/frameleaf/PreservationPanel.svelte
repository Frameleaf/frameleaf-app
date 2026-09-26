<script lang="ts">
  /**
   * Originals & preservation (FL-74, `IMP-006`).
   *
   * Ported from the design's "Originals & preservation" section of Import & protection
   * (`settings-catalog.mjs`, section `preservation`): "Include metadata and edit recipes", "Include
   * checksums and a manifest" — always on, "Always protected" — and "Preview preservation manifest",
   * which opens the Preservation export workflow. Below them, what the prototype only described:
   * the account's packages with their durable jobs, verification, download and restoration, and
   * the restorations in progress.
   *
   * A package is the signed-in account's own. Nothing here reads another account's media, and a
   * package holding Locked items downloads only from an unlocked session.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PreservationExportDialog from '$lib/components/frameleaf/PreservationExportDialog.svelte';
  import PreservationItemsDialog from '$lib/components/frameleaf/PreservationItemsDialog.svelte';
  import PreservationJobStatus from '$lib/components/frameleaf/PreservationJobStatus.svelte';
  import PreservationRestoreDialog from '$lib/components/frameleaf/PreservationRestoreDialog.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import {
    asBytes,
    isOperationActive,
    packageState,
    pollDelay,
    reasonKey,
    restoreState,
  } from '$lib/frameleaf/preservation';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getBaseUrl,
    getPreservationPackages,
    getPreservationRestores,
    MediaOperationStatus,
    PreservationPackageOrigin,
    PreservationPackageStatus,
    PreservationRestoreStatus,
    PreservationVerificationStatus,
    removePreservationPackage,
    retryPreservationPackage,
    verifyPreservationPackage,
    type PreservationPackageDto,
    type PreservationRestoreDto,
  } from '@immich/sdk';
  import { Icon, modalManager, toastManager } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  let includeMetadata = $state(true);
  let packages = $state<PreservationPackageDto[]>([]);
  let restores = $state<PreservationRestoreDto[]>([]);
  let loaded = $state(false);
  let busy = $state<string | null>(null);
  let exportOpen = $state(false);
  let itemsOpen = $state(false);
  let itemsOf = $state<PreservationPackageDto | null>(null);
  let restoreOpen = $state(false);
  let restoreOf = $state<PreservationRestoreDto | null>(null);
  let restorePackageId = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const isAdmin = $derived(!!authManager.user?.isAdmin);
  const openRestores = $derived(
    restores.filter((item) => item.status !== PreservationRestoreStatus.Completed || isOperationActive(item.operation)),
  );
  const showsJob = (item: PreservationPackageDto) =>
    !!item.operation && (isOperationActive(item.operation) || item.operation.status === MediaOperationStatus.Failed);
  const canRetryFailed = (item: PreservationPackageDto) =>
    item.origin === PreservationPackageOrigin.Export && item.counts.failed > 0 && !isOperationActive(item.operation);

  const bytes = (value: string | null) => {
    const parsed = asBytes(value);
    return parsed === null ? null : getByteUnitString(parsed, $locale ?? undefined);
  };
  const formatDate = (value: string) =>
    new Date(value).toLocaleString($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const downloadHref = (item: PreservationPackageDto, what: 'download' | 'manifest') =>
    `${getBaseUrl()}/preservation/packages/${item.id}/${what}`;

  const load = async () => {
    try {
      [packages, restores] = await Promise.all([getPreservationPackages(), getPreservationRestores()]);
      loaded = true;
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_load_error'));
    }
    schedule();
  };

  const schedule = () => {
    clearTimeout(pollTimer);
    const delay = pollDelay([...packages.map((item) => item.operation), ...restores.map((item) => item.operation)]);
    if (delay) {
      pollTimer = setTimeout(() => void load(), delay);
    }
  };

  const act = async (item: PreservationPackageDto, action: 'verify' | 'retry' | 'remove') => {
    busy = item.id;
    try {
      if (action === 'verify') {
        await verifyPreservationPackage({ id: item.id });
        toastManager.info($t('frameleaf_preservation_verify_started'));
      } else if (action === 'retry') {
        await retryPreservationPackage({ id: item.id });
        toastManager.info($t('frameleaf_preservation_retry_started'));
      } else {
        const confirmed = await modalManager.showDialog({
          prompt: $t('frameleaf_preservation_remove_confirm', { values: { name: item.name } }),
        });
        if (!confirmed) {
          return;
        }
        await removePreservationPackage({ id: item.id });
        toastManager.info($t('frameleaf_preservation_removed'));
      }
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_action_error'));
    } finally {
      busy = null;
    }
  };

  const openItems = (item: PreservationPackageDto) => {
    itemsOf = item;
    itemsOpen = true;
  };

  const startRestore = (item: PreservationPackageDto | null) => {
    restoreOf = null;
    restorePackageId = item?.id ?? null;
    restoreOpen = true;
  };

  const reopenRestore = (item: PreservationRestoreDto) => {
    restoreOf = item;
    restorePackageId = item.packageId;
    restoreOpen = true;
  };

  onMount(() => void load());
  onDestroy(() => clearTimeout(pollTimer));
</script>

<div class="preservation">
  <p class="lead">{$t('frameleaf_preservation_section_description')}</p>

  <SettingToggle
    title={$t('frameleaf_preservation_include_metadata')}
    subtitle={$t('frameleaf_preservation_include_metadata_help')}
    bind:checked={includeMetadata}
  />
  <SettingToggle
    title={$t('frameleaf_preservation_include_checksums')}
    subtitle={$t('frameleaf_preservation_include_checksums_help')}
    checked={true}
    disabled={true}
  >
    <small class="policy">{$t('frameleaf_preservation_always_protected')}</small>
  </SettingToggle>

  <div class="section-action">
    <Button onclick={() => (exportOpen = true)}>
      {$t('frameleaf_preservation_preview_manifest')}
      <Icon icon={mdiChevronRight} size="1rem" aria-hidden={true} />
    </Button>
    <Button variant="quiet" onclick={() => startRestore(null)}>{$t('frameleaf_preservation_restore_open')}</Button>
  </div>

  <section aria-labelledby="preservation-packages-heading">
    <h3 id="preservation-packages-heading">{$t('frameleaf_preservation_packages')}</h3>
    {#if !loaded}
      <p class="muted">{$t('loading')}</p>
    {:else if packages.length === 0}
      <p class="muted">{$t('frameleaf_preservation_packages_empty')}</p>
    {:else}
      <ul class="packages">
        {#each packages as item (item.id)}
          {@const status = packageState(item)}
          {@const size = bytes(item.sizeBytes)}
          <li>
            <div class="row-head">
              <div class="title">
                <strong>{item.name}</strong>
                <Badge tone={status.tone} value={$t(status.key)} label={$t(status.key)} />
              </div>
              <small class="muted">
                {$t(`frameleaf_preservation_origin_${item.origin}`)} · {formatDate(item.createdAt)}
                {#if size}· {size}{/if}
              </small>
            </div>
            <p class="facts">
              {#if item.origin === PreservationPackageOrigin.Export}
                {$t('frameleaf_preservation_package_counts', {
                  values: {
                    copied: item.counts.copied,
                    total: item.counts.total,
                    failed: item.counts.failed,
                    skipped: item.counts.skipped,
                  },
                })}
              {:else if item.manifest}
                {$t('frameleaf_preservation_package_manifest_counts', {
                  values: { exported: item.manifest.exported, failed: item.manifest.failed },
                })}
              {/if}
              {#if item.scopeDescription}· {item.scopeDescription}{/if}
            </p>
            {#if item.verification}
              <p class="facts">
                {#if item.verification.status === PreservationVerificationStatus.Unreadable}
                  {$t(reasonKey(item.verification.reasonKey) ?? 'frameleaf_preservation_reason_other')}
                {:else}
                  {$t('frameleaf_preservation_verification_counts', {
                    values: {
                      ok: item.verification.ok,
                      missing: item.verification.missing,
                      changed: item.verification.changed,
                      unexpected: item.verification.unexpected,
                      date: formatDate(item.verification.finishedAt),
                    },
                  })}
                {/if}
              </p>
            {/if}
            {#if item.expiresAt}
              <p class="facts muted">
                {$t('frameleaf_preservation_upload_expires', { values: { date: formatDate(item.expiresAt) } })}
              </p>
            {/if}
            {#if item.operation && showsJob(item)}
              <PreservationJobStatus operation={item.operation} retryable onChanged={() => void load()} />
            {/if}
            <div class="actions">
              <Button onclick={() => openItems(item)}>{$t('frameleaf_preservation_items_open')}</Button>
              {#if item.status !== PreservationPackageStatus.Removed}
                <Button disabled={busy === item.id} onclick={() => act(item, 'verify')}>
                  {$t('frameleaf_preservation_verify')}
                </Button>
              {/if}
              {#if item.downloadable}
                <a class="link-button" href={downloadHref(item, 'download')} download>
                  {$t('frameleaf_preservation_download')}
                </a>
                <a class="link-button" href={downloadHref(item, 'manifest')} download>
                  {$t('frameleaf_preservation_download_manifest')}
                </a>
              {/if}
              {#if canRetryFailed(item)}
                <Button disabled={busy === item.id} onclick={() => act(item, 'retry')}>
                  {$t('frameleaf_preservation_retry_failed')}
                </Button>
              {/if}
              {#if item.restorable}
                <Button onclick={() => startRestore(item)}>{$t('frameleaf_preservation_restore_from')}</Button>
              {/if}
              {#if !isOperationActive(item.operation)}
                <Button variant="quiet" disabled={busy === item.id} onclick={() => act(item, 'remove')}>
                  {$t('remove')}
                </Button>
              {/if}
            </div>
            {#if item.lockedContent && item.downloadable}
              <p class="facts muted">{$t('frameleaf_preservation_locked_download')}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <p class="muted">{$t('frameleaf_preservation_not_a_backup')}</p>
  </section>

  {#if openRestores.length > 0}
    <section aria-labelledby="preservation-restores-heading">
      <h3 id="preservation-restores-heading">{$t('frameleaf_preservation_restores')}</h3>
      <ul class="packages">
        {#each openRestores as item (item.id)}
          {@const status = restoreState(item)}
          <li>
            <div class="row-head">
              <div class="title">
                <strong>{item.name}</strong>
                <Badge tone={status.tone} value={$t(status.key)} label={$t(status.key)} />
              </div>
              <small class="muted">{formatDate(item.createdAt)}</small>
            </div>
            <div class="actions">
              <Button onclick={() => reopenRestore(item)}>{$t('frameleaf_preservation_restore_resume')}</Button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<PreservationExportDialog
  bind:open={exportOpen}
  bind:includeMetadata
  onCreated={() => {
    toastManager.info($t('frameleaf_preservation_export_started'));
    void load();
  }}
/>
<PreservationItemsDialog bind:open={itemsOpen} item={itemsOf} />
<PreservationRestoreDialog
  bind:open={restoreOpen}
  bind:restore={restoreOf}
  {packages}
  packageId={restorePackageId}
  {isAdmin}
  onChanged={() => void load()}
/>

<style>
  .preservation {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .lead,
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .policy {
    display: block;
    margin-top: 0.25rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .section-action {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem 0 0.75rem;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--fl-border);
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-size);
  }
  .packages {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .packages > li {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    overflow-wrap: anywhere;
  }
  .facts {
    margin: 0;
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .link-button {
    display: inline-flex;
    align-items: center;
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    text-decoration: none;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .link-button:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
</style>
