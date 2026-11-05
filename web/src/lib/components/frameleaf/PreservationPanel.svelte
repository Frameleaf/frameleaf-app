<script lang="ts">
  /**
   * Import & export › Export a copy (FL-74, `IMP-006`; rebuilt on the kit after the approved
   * prototype's `settings-v2/library/export.jsx`). The last copy first (complete, being made, or
   * with files that could not be copied), "Keep it somewhere else", the account's copies as one list
   * with Manage on each, and the two ways to restore from a copy. What goes into a copy (albums,
   * edits and details; the checklist of files) is chosen in the Export a copy dialog.
   *
   * A copy (a preservation package) is the signed-in account's own. Nothing here reads another
   * account's media, and a copy holding Locked items downloads only from an unlocked session.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PreservationExportDialog from '$lib/components/frameleaf/PreservationExportDialog.svelte';
  import PreservationItemsDialog from '$lib/components/frameleaf/PreservationItemsDialog.svelte';
  import PreservationJobStatus from '$lib/components/frameleaf/PreservationJobStatus.svelte';
  import PreservationRestoreDialog from '$lib/components/frameleaf/PreservationRestoreDialog.svelte';
  import BuddyRestoreSection from '$lib/components/frameleaf/cloud/BuddyRestoreSection.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import {
    asBytes,
    isOperationActive,
    packageState,
    pollDelay,
    reasonKey,
    restoreState,
  } from '$lib/frameleaf/preservation';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
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
  } from '@frameleaf/sdk';
  import { Icon, modalManager, toastManager } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiChevronRight,
    mdiLaptop,
    mdiPackageVariantClosed,
    mdiPackageVariantClosedCheck,
    mdiServerOutline,
    mdiSync,
  } from '@mdi/js';
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
  let managingId = $state<string | null>(null);
  let manageOpen = $state(false);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** A read on its way when the panel went must not schedule another. */
  let destroyed = false;

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
    new Date(value).toLocaleDateString($locale ?? undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const formatWhen = (value: string) =>
    new Date(value).toLocaleString($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const downloadHref = (item: PreservationPackageDto, what: 'download' | 'manifest') =>
    `${getBaseUrl()}/preservation/packages/${item.id}/${what}`;

  /** The Badge tones of `packageState` as the kit's four. */
  const kitTone = (tone: string): KitTone =>
    tone === 'danger' ? 'bad' : tone === 'warning' ? 'warn' : tone === 'neutral' ? 'off' : 'good';

  /** The copy this account made last, which the page opens on. */
  const latest = $derived(
    packages
      .filter(
        (item) => item.origin === PreservationPackageOrigin.Export && item.status !== PreservationPackageStatus.Removed,
      )
      // filter() already made a copy, so sorting it in place leaves `packages` alone (toSorted needs Chrome 110)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
  );
  const restorable = $derived(packages.some((item) => item.restorable));
  const managing = $derived(packages.find((item) => item.id === managingId) ?? null);

  const counts = (item: PreservationPackageDto) => {
    const parts: string[] = [];
    if (item.origin === PreservationPackageOrigin.Export) {
      parts.push(
        $t('frameleaf_preservation_package_counts', {
          values: {
            copied: item.counts.copied,
            total: item.counts.total,
            failed: item.counts.failed,
            skipped: item.counts.skipped,
          },
        }),
      );
    } else if (item.manifest) {
      parts.push(
        $t('frameleaf_preservation_package_manifest_counts', {
          values: { exported: item.manifest.exported, failed: item.manifest.failed },
        }),
      );
    }
    return parts.join(' · ');
  };
  /** One line: how the last check went, or how far the copy got. */
  const note = (item: PreservationPackageDto) => {
    const verification = item.verification;
    let line: string;
    if (verification?.status === PreservationVerificationStatus.Unreadable) {
      line = $t(reasonKey(verification.reasonKey) ?? 'frameleaf_preservation_reason_other');
    } else if (verification?.status === PreservationVerificationStatus.Verified) {
      line = $t('frameleaf_preservation_note_checked', {
        values: { count: verification.ok, date: formatDate(verification.finishedAt) },
      });
    } else if (verification) {
      line = $t('frameleaf_preservation_verification_counts', {
        values: {
          ok: verification.ok,
          missing: verification.missing,
          changed: verification.changed,
          unexpected: verification.unexpected,
          date: formatWhen(verification.finishedAt),
        },
      });
    } else if (item.origin === PreservationPackageOrigin.Export) {
      line = $t('frameleaf_preservation_note_copied', {
        values: { copied: item.counts.copied, total: item.counts.total },
      });
    } else {
      line = counts(item);
    }
    const links =
      item.bookmarks && item.bookmarks.selected > 0
        ? $t('frameleaf_preservation_package_bookmark_counts', { values: item.bookmarks })
        : '';
    return [line, links].filter(Boolean).join(' · ');
  };
  const detail = (item: PreservationPackageDto) =>
    [item.scopeDescription || $t(`frameleaf_preservation_origin_${item.origin}`), formatDate(item.createdAt)].join(
      ' · ',
    );

  const hero = $derived.by(() => {
    if (!latest) {
      return {
        tone: 'quiet' as const,
        icon: mdiPackageVariantClosed,
        title: $t('frameleaf_preservation_hero_none'),
        body: $t('frameleaf_preservation_hero_none_body'),
      };
    }
    if (isOperationActive(latest.operation)) {
      return {
        tone: 'good' as const,
        icon: mdiSync,
        title: $t('frameleaf_preservation_hero_making'),
        body: $t('frameleaf_preservation_hero_making_body'),
      };
    }
    if (latest.counts.failed > 0 || latest.status === PreservationPackageStatus.Incomplete) {
      return {
        tone: 'warn' as const,
        icon: mdiAlertCircleOutline,
        title: $t('frameleaf_preservation_hero_failed', { values: { count: latest.counts.failed } }),
        body: $t('frameleaf_preservation_hero_failed_body', {
          values: { date: formatDate(latest.createdAt), copied: latest.counts.copied, total: latest.counts.total },
        }),
      };
    }
    if (
      latest.status === PreservationPackageStatus.Unreadable ||
      latest.operation?.status === MediaOperationStatus.Failed
    ) {
      return {
        tone: 'bad' as const,
        icon: mdiAlertCircleOutline,
        title: $t('frameleaf_preservation_hero_broken'),
        body: $t('frameleaf_preservation_hero_broken_body', { values: { date: formatDate(latest.createdAt) } }),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiPackageVariantClosedCheck,
      title: $t('frameleaf_preservation_hero_done'),
      body: $t('frameleaf_preservation_hero_done_body', {
        values: { date: formatDate(latest.createdAt), total: latest.counts.total },
      }),
    };
  });

  const load = async () => {
    try {
      const [nextPackages, nextRestores] = await Promise.all([getPreservationPackages(), getPreservationRestores()]);
      if (destroyed) {
        return;
      }
      [packages, restores] = [nextPackages, nextRestores];
      loaded = true;
    } catch (error) {
      if (!destroyed) {
        handleError(error, $t('frameleaf_preservation_load_error'));
      }
    }
    schedule();
  };

  const schedule = () => {
    clearTimeout(pollTimer);
    if (destroyed) {
      return;
    }
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
        manageOpen = false;
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
    manageOpen = false;
    itemsOf = item;
    itemsOpen = true;
  };

  const startRestore = (item: PreservationPackageDto | null) => {
    manageOpen = false;
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
  onDestroy(() => {
    destroyed = true;
    clearTimeout(pollTimer);
  });
</script>

<KitPage>
  <Hero
    label={$t('frameleaf_preservation_packages')}
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
  >
    {#snippet actions()}
      {#if latest && hero.tone === 'warn'}
        <Button variant="primary" onclick={() => openItems(latest)}>{$t('frameleaf_preservation_see_which')}</Button>
      {/if}
      <Button variant={latest && hero.tone === 'warn' ? 'default' : 'primary'} onclick={() => (exportOpen = true)}
        >{$t('frameleaf_preservation_preview_manifest')}</Button
      >
    {/snippet}
    {#if latest?.operation && isOperationActive(latest.operation)}
      <div class="job">
        <PreservationJobStatus operation={latest.operation} retryable onChanged={() => void load()} />
      </div>
    {/if}
  </Hero>

  <Notice title={$t('frameleaf_preservation_keep_elsewhere')}>{$t('frameleaf_preservation_not_a_backup')}</Notice>

  <Section
    title={$t('frameleaf_preservation_packages')}
    description={$t('frameleaf_preservation_packages_description')}
  >
    <ItemList>
      {#if !loaded}
        <Item icon={mdiPackageVariantClosed} quiet off name={$t('loading')} />
      {:else if packages.length === 0}
        <Item
          icon={mdiPackageVariantClosed}
          quiet
          off
          name={$t('frameleaf_preservation_packages_none')}
          detail={$t('frameleaf_preservation_packages_none_detail')}
        />
      {:else}
        {#each packages as item, index (item.id)}
          {@const status = packageState(item)}
          {@const size = bytes(item.sizeBytes)}
          <Item
            icon={mdiPackageVariantClosed}
            quiet={index > 0}
            name={item.name}
            detail={detail(item)}
            tone={kitTone(status.tone)}
            status={$t(status.key)}
            note={note(item)}
          >
            {#snippet measure()}
              {#if size}
                <span class="measure"><strong>{size}</strong></span>
              {/if}
            {/snippet}
            {#snippet action()}
              <Button
                label={$t('frameleaf_preservation_manage_label', { values: { name: item.name } })}
                onclick={() => {
                  managingId = item.id;
                  manageOpen = true;
                }}
              >
                {$t('frameleaf_preservation_manage')}
                <Icon icon={mdiChevronRight} size="16" aria-hidden />
              </Button>
            {/snippet}
          </Item>
        {/each}
      {/if}
    </ItemList>
    {#each packages.filter((item) => item !== latest && showsJob(item)) as item (item.id)}
      {#if item.operation}
        <div class="job">
          <PreservationJobStatus operation={item.operation} retryable onChanged={() => void load()} />
        </div>
      {/if}
    {/each}
  </Section>

  {#if openRestores.length > 0}
    <Section title={$t('frameleaf_preservation_restores')}>
      <ItemList>
        {#each openRestores as item (item.id)}
          {@const status = restoreState(item)}
          <Item
            icon={mdiPackageVariantClosed}
            name={item.name}
            detail={formatWhen(item.createdAt)}
            tone={kitTone(status.tone)}
            status={$t(status.key)}
          >
            {#snippet action()}
              <Button onclick={() => reopenRestore(item)}>{$t('frameleaf_preservation_restore_resume')}</Button>
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>
  {/if}

  <Section
    title={$t('frameleaf_preservation_restore_open')}
    description={$t('frameleaf_preservation_restore_description')}
  >
    <Links
      rows={[
        {
          icon: mdiServerOutline,
          title: $t('frameleaf_preservation_restore_on_server'),
          body: restorable
            ? $t('frameleaf_preservation_restore_on_server_body')
            : $t('frameleaf_preservation_restore_on_server_none'),
          onSelect: () => startRestore(null),
          disabled: !restorable,
        },
        {
          icon: mdiLaptop,
          title: $t('frameleaf_preservation_restore_on_computer'),
          body: $t('frameleaf_preservation_restore_on_computer_body'),
          onSelect: () => startRestore(null),
        },
      ]}
    />
    {#if isAdmin}
      <div class="pad">
        <Notice title={$t('frameleaf_preservation_lost_something')}>
          {$t('frameleaf_preservation_lost_something_body')}
          {#snippet action()}
            <a class="fl-control button" href={commandCenterUrl('backups', 'restore')}
              >{$t('frameleaf_preservation_restore_backup')}</a
            >
          {/snippet}
        </Notice>
      </div>
    {/if}
  </Section>

  <!-- A dated backup of this account's own library (Buddy Backup), for people who don't open the Backup page. -->
  <BuddyRestoreSection />
</KitPage>

<Dialog
  bind:open={manageOpen}
  onClosed={() => (managingId = null)}
  title={managing ? $t('frameleaf_preservation_manage_title', { values: { name: managing.name } }) : ''}
  closeLabel={$t('close')}
>
  {#if managing}
    {@const size = bytes(managing.sizeBytes)}
    <p class="lead">{[detail(managing), size, counts(managing)].filter(Boolean).join(' · ')}</p>
    {#if managing.lockedContent && managing.downloadable}
      <p class="lead">{$t('frameleaf_preservation_locked_download')}</p>
    {/if}
    {#if managing.expiresAt}
      <p class="lead">
        {$t('frameleaf_preservation_upload_expires', { values: { date: formatWhen(managing.expiresAt) } })}
      </p>
    {/if}
    {#if managing.downloadable}
      <Row
        label={$t('frameleaf_preservation_manage_download')}
        help={$t('frameleaf_preservation_manage_download_help')}
      >
        <a class="fl-control button primary" href={downloadHref(managing, 'download')} download
          >{$t('frameleaf_preservation_download')}</a
        >
      </Row>
    {/if}
    {#if managing.status !== PreservationPackageStatus.Removed}
      <Row label={$t('frameleaf_preservation_check_again')} help={$t('frameleaf_preservation_manage_check_help')}>
        <Button disabled={busy === managing.id} onclick={() => act(managing, 'verify')}
          >{$t('frameleaf_preservation_verify')}</Button
        >
      </Row>
    {/if}
    {#if canRetryFailed(managing)}
      <Row label={$t('frameleaf_preservation_retry_failed')} help={$t('frameleaf_preservation_manage_retry_help')}>
        <Button disabled={busy === managing.id} onclick={() => act(managing, 'retry')}
          >{$t('frameleaf_preservation_retry_failed')}</Button
        >
      </Row>
    {/if}
    {#if managing.restorable}
      <Row label={$t('frameleaf_preservation_manage_restore')} help={$t('frameleaf_preservation_manage_restore_help')}>
        <Button onclick={() => startRestore(managing)}>{$t('frameleaf_preservation_restore_from')}</Button>
      </Row>
    {/if}
    {#if !isOperationActive(managing.operation)}
      <Row
        label={$t('frameleaf_preservation_manage_remove')}
        help={size
          ? $t('frameleaf_preservation_manage_remove_help', { values: { size } })
          : $t('frameleaf_preservation_manage_remove_help_plain')}
      >
        <Button variant="danger" disabled={busy === managing.id} onclick={() => act(managing, 'remove')}
          >{$t('frameleaf_preservation_manage_remove_action')}</Button
        >
      </Row>
    {/if}
    <Advanced summary={$t('frameleaf_preservation_manage_more')}>
      <div class="more">
        {#if managing.downloadable}
          <a class="fl-control button" href={downloadHref(managing, 'manifest')} download
            >{$t('frameleaf_preservation_download_manifest')}</a
          >
        {/if}
        <Button onclick={() => openItems(managing)}>{$t('frameleaf_preservation_items_open')}</Button>
      </div>
    </Advanced>
  {/if}
</Dialog>

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
  .job {
    padding: var(--fl-space-4) var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  .measure {
    font-size: var(--fl-font-callout);
    white-space: nowrap;
  }
  .measure strong {
    font-weight: 600;
  }
  .pad {
    padding-bottom: var(--fl-space-6);
  }
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    white-space: nowrap;
  }
  .lead {
    margin: 0 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .more {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    padding-bottom: var(--fl-space-4);
  }
</style>
