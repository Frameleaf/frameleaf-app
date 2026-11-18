<script lang="ts">
  /**
   * Backup › Restore › Files or folders (FL-1666), after the approved prototype (`BackupBrowse.jsx`):
   * a Cloud Backup is a dated copy of this server's folders, so it can be browsed by date and folder,
   * files or whole folders ticked, and a single file taken back to an earlier version. Three steps:
   * Choose, Where they go, Review. Nothing changes until Restore is pressed on Review; the restore then
   * runs on the server and shows in Activity.
   *
   * The server does not count files in the way before a restore, so Review says they are checked as it
   * runs, for either destination.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import BackupFolderChooser from '$lib/components/frameleaf/backup/BackupFolderChooser.svelte';
  import BackLink from '$lib/components/frameleaf/settings/kit/BackLink.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Steps from '$lib/components/frameleaf/settings/kit/Steps.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import {
    BROWSE_PAGE,
    childPath,
    crumbsOf,
    folderWords,
    heldVersion,
    isChosen,
    isFolderPath,
    nameOf,
    pickTotals,
    togglePick,
    type BrowsePick,
  } from '$lib/frameleaf/backup-browse';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { backupPageUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    browseCloudBackup,
    CloudBackupBrowseEntryType,
    CloudBackupRestoreScope,
    getCloudBackupFileVersions,
    restoreCloudBackup,
    type CloudBackupBrowseEntryDto,
    type CloudBackupFileVersionDto,
    type CloudBackupManifestDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiBackupRestore,
    mdiChevronRight,
    mdiCloudOutline,
    mdiFileDocumentOutline,
    mdiFolderOutline,
    mdiHistory,
    mdiImageOutline,
    mdiVideoOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    manifests,
    start,
    onDone,
  }: {
    /** Kept Cloud Backups, newest first. */
    manifests: CloudBackupManifestDto[];
    /** The backup to open on, by its key; the newest when it is not kept. */
    start?: string | null;
    /** The restore has started. */
    onDone: () => void;
  } = $props();

  type Step = 'browse' | 'where' | 'review';
  const STEPS: { id: Step; title: string; detail: string }[] = $derived([
    {
      id: 'browse',
      title: $t('frameleaf_backup_browse_step_choose'),
      detail: $t('frameleaf_backup_browse_step_choose_detail'),
    },
    {
      id: 'where',
      title: $t('frameleaf_backup_browse_step_where'),
      detail: $t('frameleaf_backup_browse_step_where_detail'),
    },
    {
      id: 'review',
      title: $t('frameleaf_backup_browse_step_review'),
      detail: $t('frameleaf_backup_browse_step_review_detail'),
    },
  ]);

  const initial = () => manifests.find((manifest) => manifest.key === start)?.key ?? manifests[0]?.key ?? '';
  let step = $state<Step>('browse');
  let manifestKey = $state(initial());
  let folder = $state('/');
  let picks = $state<BrowsePick[]>([]);
  let to = $state<'original' | 'folder'>('original');
  let target = $state('');
  let chooserOpen = $state(false);
  let restoring = $state(false);
  let restoreError = $state('');

  const manifest = $derived(manifests.find((item) => item.key === manifestKey));
  const at = $derived(STEPS.findIndex(({ id }) => id === step));
  const steps = $derived(
    STEPS.map(({ title, detail }, index) => ({
      title,
      detail,
      state: index < at ? ('done' as const) : index > at ? ('waiting' as const) : ('now' as const),
    })),
  );
  const sum = $derived(pickTotals(picks));
  const elsewhere = $derived(to === 'folder');
  const size = (bytes: number) => formatBytes(bytes, $locale);
  const when = (value: string) => {
    const { key, values } = backupWhen(new Date(value), { locale: $locale });
    return $t(key, { values });
  };
  const files = (count: number) => $t('frameleaf_backup_browse_files', { values: { count } });

  // ---- One folder of one backup, read a page at a time ----
  type Listing = {
    key: string;
    entries: CloudBackupBrowseEntryDto[];
    total: number;
    hiddenLocked: number;
    failed?: boolean;
  };
  let listing = $state<Listing>();
  let more = $state(false);
  const listingKey = $derived(`${manifestKey}\n${folder}`);
  const current = $derived(listing?.key === listingKey ? listing : undefined);

  const read = async (key: string, path: string, offset: number) => {
    const requested = `${key}\n${path}`;
    try {
      const page = await browseCloudBackup({
        cloudBackupBrowseDto: { manifestKey: key, path, offset, limit: BROWSE_PAGE },
      });
      if (requested !== listingKey) {
        return;
      }
      const before = offset > 0 && listing?.key === requested ? listing.entries : [];
      listing = {
        key: requested,
        entries: [...before, ...page.entries],
        total: page.total,
        hiddenLocked: page.hiddenLocked,
      };
    } catch {
      if (requested === listingKey && offset === 0) {
        listing = { key: requested, entries: [], total: 0, hiddenLocked: 0, failed: true };
      }
    }
  };

  $effect(() => {
    if (step === 'browse' && manifestKey && listing?.key !== listingKey) {
      void read(manifestKey, folder, 0);
    }
  });

  const showMore = async () => {
    if (!current) {
      return;
    }
    more = true;
    await read(manifestKey, folder, current.entries.length);
    more = false;
  };

  const left = $derived(current ? Math.max(0, current.total - current.entries.length) : 0);

  const chooseDate = (key: string) => {
    manifestKey = key;
    // What is ticked was read from the other backup; a different date starts again.
    picks = [];
  };

  const asPick = (entry: CloudBackupBrowseEntryDto): BrowsePick => ({
    path: childPath(folder, entry.name),
    folder: entry.type === CloudBackupBrowseEntryType.Folder,
    size: entry.size,
    files: entry.files,
  });

  const FILE_ICONS: Record<string, string> = {
    mov: mdiVideoOutline,
    mp4: mdiVideoOutline,
    m4v: mdiVideoOutline,
    avi: mdiVideoOutline,
    mkv: mdiVideoOutline,
    pdf: mdiFileDocumentOutline,
    xmp: mdiFileDocumentOutline,
    json: mdiFileDocumentOutline,
  };
  const fileIcon = (name: string) => FILE_ICONS[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? mdiImageOutline;

  // ---- Earlier versions of one file ----
  let versionsOpen = $state(false);
  let versionsPath = $state('');
  let versions = $state<CloudBackupFileVersionDto[] | null>(null);
  let versionsFailed = $state(false);
  let version = $state('');
  const held = $derived(versions && manifest ? heldVersion(versions, manifest) : undefined);

  const openVersions = async (path: string) => {
    versionsPath = path;
    versions = null;
    versionsFailed = false;
    versionsOpen = true;
    try {
      const answer = await getCloudBackupFileVersions({ cloudBackupFileVersionsDto: { path } });
      if (versionsPath !== path) {
        return;
      }
      versions = answer.versions;
      const chosen = manifest ? heldVersion(answer.versions, manifest) : answer.versions[0];
      version = chosen?.manifestKey ?? '';
    } catch {
      versionsFailed = true;
    }
  };

  const restoreVersion = () => {
    const chosen = versions?.find((item) => item.manifestKey === version);
    if (!chosen) {
      return;
    }
    manifestKey = chosen.manifestKey;
    picks = [{ path: versionsPath, folder: false, size: chosen.size, files: 1 }];
    versionsOpen = false;
    step = 'where';
  };

  // ---- Where they go, and the restore itself ----
  const targetValid = $derived(isFolderPath(target));

  const restore = async () => {
    restoring = true;
    restoreError = '';
    try {
      await restoreCloudBackup({
        cloudBackupRestoreDto: {
          manifestKey,
          scope: CloudBackupRestoreScope.Files,
          paths: picks.map((pick) => pick.path),
          ...(elsewhere && { folder: target.trim() }),
        },
      });
      onDone();
    } catch (error) {
      restoreError = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      restoring = false;
    }
  };
</script>

<BackLink href={backupPageUrl('restore')} label={$t('frameleaf_backup_tab_restore')} />

<Section title={$t('frameleaf_backup_browse_title')} description={$t('frameleaf_backup_browse_description')}>
  <div class="steps">
    <Steps {steps} label={$t('frameleaf_backup_browse_steps')} />
  </div>
</Section>

{#if step === 'browse'}
  <Section
    title={$t('frameleaf_backup_browse_choose_title')}
    description={$t('frameleaf_backup_browse_choose_description')}
  >
    <Row label={$t('frameleaf_backup_browse_date')} help={$t('frameleaf_backup_browse_date_help')}>
      <select
        aria-label={$t('frameleaf_backup_browse_date_label')}
        value={manifestKey}
        onchange={(event) => chooseDate(event.currentTarget.value)}
      >
        {#each manifests as item (item.key)}
          <option value={item.key}>{when(item.createdAt)}</option>
        {/each}
      </select>
    </Row>
    <nav class="crumbs" aria-label={$t('frameleaf_backup_browse_crumbs')}>
      <button type="button" aria-current={folder === '/' ? 'page' : undefined} onclick={() => (folder = '/')}>
        <Icon icon={mdiCloudOutline} size="16" aria-hidden />
        {$t('frameleaf_backup_browse_top')}
      </button>
      {#each crumbsOf(folder) as crumb, index (crumb.path)}
        <Icon icon={mdiChevronRight} size="16" aria-hidden />
        <button
          type="button"
          aria-current={index === crumbsOf(folder).length - 1 ? 'page' : undefined}
          onclick={() => (folder = crumb.path)}>{crumb.name}</button
        >
      {/each}
    </nav>
    {#if !current}
      <div class="pad" role="status" aria-busy="true">
        <span class="sr-only">{$t('loading')}</span>
        <Skeleton variant="text" lines={3} />
      </div>
    {:else if current.failed}
      <div class="pad">
        <InlineError
          compact
          message={$t('frameleaf_backup_browse_failed')}
          onRetry={() => read(manifestKey, folder, 0)}
        />
      </div>
    {:else}
      <ul class="list">
        {#each current.entries as entry (entry.name)}
          {@const path = childPath(folder, entry.name)}
          {@const isFolder = entry.type === CloudBackupBrowseEntryType.Folder}
          {@const ticked = isChosen(picks, path)}
          <li>
            <input
              type="checkbox"
              aria-label={$t('frameleaf_backup_browse_choose_item', { values: { name: entry.name } })}
              checked={ticked}
              disabled={ticked && picks.every((pick) => pick.path !== path)}
              onchange={() => (picks = togglePick(picks, asPick(entry)))}
            />
            <span class="tile" aria-hidden="true">
              <Icon icon={isFolder ? mdiFolderOutline : fileIcon(entry.name)} size="20" />
            </span>
            {#if isFolder}
              <button type="button" class="name" onclick={() => (folder = path)}>
                <strong>{entry.name}</strong>
                <small>{files(entry.files)} · {size(entry.size)}</small>
              </button>
              <Button
                label={$t('frameleaf_backup_browse_open_label', { values: { name: entry.name } })}
                onclick={() => (folder = path)}
              >
                {$t('frameleaf_backup_browse_open')}
                <Icon icon={mdiChevronRight} size="18" aria-hidden />
              </Button>
            {:else}
              <span class="name">
                <strong>{entry.name}</strong>
                <small>{size(entry.size)}</small>
              </span>
              <Button
                label={$t('frameleaf_backup_browse_versions_label', { values: { name: entry.name } })}
                onclick={() => void openVersions(path)}
              >
                <Icon icon={mdiHistory} size="18" aria-hidden />
                {$t('frameleaf_backup_browse_versions')}
              </Button>
            {/if}
          </li>
        {:else}
          <li class="empty">{$t('frameleaf_backup_browse_empty')}</li>
        {/each}
        {#if left > 0}
          <li class="more">
            <Button disabled={more} onclick={() => void showMore()}>
              {$t('frameleaf_backup_browse_more', { values: { count: left } })}
            </Button>
          </li>
        {/if}
      </ul>
      {#if current.hiddenLocked > 0}
        <p class="locked">{$t('frameleaf_backup_browse_locked', { values: { count: current.hiddenLocked } })}</p>
      {/if}
    {/if}
    <div class="actions">
      <Button variant="primary" disabled={picks.length === 0} onclick={() => (step = 'where')}>
        {$t('frameleaf_backup_browse_continue')}
      </Button>
      <Button disabled={picks.length === 0} onclick={() => (picks = [])}>{$t('frameleaf_backup_browse_clear')}</Button>
      <span class="count" role="status">
        {picks.length === 0
          ? $t('frameleaf_backup_browse_nothing')
          : $t('frameleaf_backup_browse_chosen', { values: { count: sum.files, size: size(sum.size) } })}
      </span>
    </div>
  </Section>
{:else if step === 'where'}
  <Section
    title={$t('frameleaf_backup_browse_where_title')}
    description={$t('frameleaf_backup_browse_where_description', {
      values: { count: sum.files, size: size(sum.size), when: manifest ? when(manifest.createdAt) : '' },
    })}
  >
    <div class="choice" role="radiogroup" aria-label={$t('frameleaf_backup_browse_where_label')}>
      {#each [{ id: 'original', title: $t('frameleaf_backup_browse_original'), detail: $t('frameleaf_backup_browse_original_detail') }, { id: 'folder', title: $t('frameleaf_backup_browse_elsewhere'), detail: $t('frameleaf_backup_browse_elsewhere_detail') }] as option (option.id)}
        <label class:is-on={to === option.id}>
          <input
            type="radio"
            name="backup-browse-to"
            checked={to === option.id}
            onchange={() => (to = option.id === 'folder' ? 'folder' : 'original')}
          />
          <span>
            <strong>{option.title}</strong>
            <small>{option.detail}</small>
          </span>
        </label>
      {/each}
    </div>
    {#if elsewhere}
      <Row label={$t('frameleaf_backup_browse_folder')} help={$t('frameleaf_backup_browse_folder_help')}>
        <input
          type="text"
          class="folder"
          aria-label={$t('frameleaf_backup_browse_folder_label')}
          aria-invalid={target.trim() !== '' && !targetValid}
          placeholder="/mnt/photos/Restored"
          value={target}
          oninput={(event) => (target = event.currentTarget.value)}
        />
        <Button onclick={() => (chooserOpen = true)}>{$t('frameleaf_backup_browse_choose_folder')}</Button>
      </Row>
    {/if}
    <div class="actions">
      <Button variant="primary" disabled={elsewhere && !targetValid} onclick={() => (step = 'review')}>
        {$t('frameleaf_backup_browse_continue')}
      </Button>
      <Button onclick={() => (step = 'browse')}>{$t('frameleaf_backup_browse_back')}</Button>
    </div>
  </Section>
{:else}
  <Section
    title={$t('frameleaf_backup_browse_step_review')}
    description={$t('frameleaf_backup_browse_review_description')}
  >
    <Facts
      columns={4}
      rows={[
        {
          label: $t('frameleaf_backup_browse_fact_from'),
          value: $t('frameleaf_buddy_cloud_backup'),
          detail: manifest ? when(manifest.createdAt) : undefined,
        },
        { label: $t('frameleaf_backup_browse_fact_bringing'), value: files(sum.files), detail: size(sum.size) },
        {
          label: $t('frameleaf_backup_browse_fact_to'),
          value: elsewhere ? $t('frameleaf_backup_browse_to_elsewhere') : $t('frameleaf_backup_browse_to_original'),
          detail: elsewhere ? target.trim() : $t('frameleaf_backup_browse_to_original_detail'),
        },
        {
          label: $t('frameleaf_backup_browse_fact_in_way'),
          value: $t('frameleaf_backup_browse_in_way_checked'),
          detail: $t('frameleaf_backup_browse_in_way_detail'),
        },
      ]}
    />
    <ul class="list is-plain" aria-label={$t('frameleaf_backup_browse_chosen_label')}>
      {#each picks as pick (pick.path)}
        <li>
          <span class="tile" aria-hidden="true">
            <Icon icon={pick.folder ? mdiFolderOutline : fileIcon(pick.path)} size="20" />
          </span>
          <span class="name">
            <strong>{nameOf(pick.path)}</strong>
            <small>{folderWords(pick.path) || $t('frameleaf_backup_browse_top')}</small>
          </span>
          <span class="value">{pick.folder ? `${files(pick.files)} · ` : ''}{size(pick.size)}</span>
        </li>
      {/each}
    </ul>
    <Notice
      title={elsewhere
        ? $t('frameleaf_backup_browse_aside_title_elsewhere')
        : $t('frameleaf_backup_browse_aside_title_original')}
    >
      {elsewhere
        ? $t('frameleaf_backup_browse_aside_body_elsewhere')
        : $t('frameleaf_backup_browse_aside_body_original')}
    </Notice>
    {#if restoreError}
      <p class="error" role="alert">{restoreError}</p>
    {/if}
    <div class="actions">
      <Button variant="primary" disabled={restoring} onclick={() => void restore()}>
        <Icon icon={mdiBackupRestore} size="18" aria-hidden />
        {$t('frameleaf_backup_browse_restore', { values: { count: sum.files } })}
      </Button>
      <Button disabled={restoring} onclick={() => (step = 'where')}>{$t('frameleaf_backup_browse_back')}</Button>
    </div>
  </Section>
{/if}

<Dialog bind:open={versionsOpen} title={$t('frameleaf_backup_browse_versions')} closeLabel={$t('close')}>
  <p class="lead">
    <strong>{nameOf(versionsPath)}</strong>
    {#if versions}
      <small>
        {[
          folderWords(versionsPath),
          versions.length > 1
            ? $t('frameleaf_backup_browse_versions_changed', { values: { count: versions.length } })
            : $t('frameleaf_backup_browse_versions_none'),
        ]
          .filter(Boolean)
          .join(' · ')}
      </small>
    {/if}
  </p>
  {#if versionsFailed}
    <p class="error" role="alert">{$t('frameleaf_backup_browse_versions_failed')}</p>
  {:else if !versions}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="text" lines={2} />
    </div>
  {:else}
    <ul
      class="versions"
      role="radiogroup"
      aria-label={$t('frameleaf_backup_browse_versions_list', { values: { name: nameOf(versionsPath) } })}
    >
      {#each versions as item, index (item.manifestKey)}
        <li>
          <label class:is-on={version === item.manifestKey}>
            <input
              type="radio"
              name="backup-browse-version"
              checked={version === item.manifestKey}
              onchange={() => (version = item.manifestKey)}
            />
            <span>
              <strong>{when(item.createdAt)}</strong>
              <small>
                {[
                  size(item.size),
                  index === 0 ? $t('frameleaf_backup_browse_versions_newest') : '',
                  item.manifestKey === held?.manifestKey ? $t('frameleaf_backup_browse_versions_browsing') : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </span>
          </label>
        </li>
      {/each}
    </ul>
    <p class="hint">{$t('frameleaf_backup_browse_versions_hint')}</p>
  {/if}
  {#snippet actions()}
    <Button onclick={() => (versionsOpen = false)}>{$t('frameleaf_cloud_cancel')}</Button>
    <Button variant="primary" initialFocus disabled={!versions || !version} onclick={restoreVersion}>
      {$t('frameleaf_backup_browse_versions_restore')}
    </Button>
  {/snippet}
</Dialog>

<BackupFolderChooser
  bind:open={chooserOpen}
  start={targetValid ? target.trim() : undefined}
  onChoose={(path) => (target = path)}
/>

<style>
  .steps {
    padding: 0 0 var(--fl-space-6);
  }
  .pad {
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
  }
  select,
  input.folder {
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  input.folder {
    width: 260px;
  }
  input.folder[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }

  /* Breadcrumbs: the first crumb's own padding is pulled back so its icon lines up with the ticks below. */
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-1);
    padding: var(--fl-space-3) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    border-top: 1px solid var(--fl-border);
  }
  .crumbs button {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 32px;
    padding: 0 var(--fl-space-2);
    color: var(--fl-muted);
    font: inherit;
    border-radius: var(--fl-radius-control);
  }
  .crumbs button:first-child {
    margin-inline-start: calc(-1 * var(--fl-space-2));
  }
  .crumbs button:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .crumbs button[aria-current] {
    color: var(--fl-text);
    font-weight: 600;
  }
  .crumbs button:focus-visible,
  button.name:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }

  /* Folders and files in one backup */
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: grid;
    grid-template-columns: 20px auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-3);
    min-height: 60px;
    padding: var(--fl-space-2) 0;
    font-size: var(--fl-font-callout);
    border-top: 1px solid var(--fl-border);
  }
  .list.is-plain {
    padding-bottom: var(--fl-space-4);
  }
  .list.is-plain li {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .list input {
    width: 20px;
    height: 20px;
    min-height: 0;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .list li.empty {
    display: block;
    min-height: 0;
    padding: var(--fl-space-4) 0;
    color: var(--fl-muted);
  }
  .list li.more {
    display: block;
    min-height: 0;
    padding: var(--fl-space-3) 0;
  }
  .tile {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    color: var(--fl-accent);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-control);
  }
  .name {
    display: block;
    min-width: 0;
    padding: 0;
    color: var(--fl-text);
    font: inherit;
    text-align: start;
  }
  .name strong {
    display: block;
    overflow: hidden;
    font-size: var(--fl-font-size);
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .name small,
  .value {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  button.name {
    cursor: pointer;
  }
  button.name:hover strong {
    color: var(--fl-accent);
  }
  .locked {
    margin: 0;
    padding: var(--fl-space-3) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    border-top: 1px solid var(--fl-border);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-4) 0 var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  .count {
    margin-inline-start: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .error {
    margin: var(--fl-space-4) 0 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-callout);
  }

  /* Where restored files go */
  .choice {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--fl-space-3);
    padding: 0 0 var(--fl-space-6);
  }
  .choice label,
  .versions label {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--fl-space-3);
    margin: 0;
    padding: var(--fl-space-4);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    cursor: pointer;
  }
  .choice label.is-on,
  .versions label.is-on {
    border-color: var(--fl-accent);
  }
  .choice input,
  .versions input {
    width: 18px;
    height: 18px;
    min-height: 0;
    margin: 2px 0 0;
    accent-color: var(--fl-accent);
  }
  .choice strong,
  .versions strong {
    display: block;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .choice small,
  .versions small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }

  /* Earlier versions of one file */
  .lead {
    margin: 0 0 var(--fl-space-4);
  }
  .lead strong {
    display: block;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .lead small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  .versions {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .hint {
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }

  @container kit (max-width: 620px) {
    .choice {
      grid-template-columns: 1fr;
    }
    .list li {
      grid-template-columns: 20px auto minmax(0, 1fr);
    }
    .list li > :global(button:last-child) {
      grid-column: 3;
      justify-self: start;
    }
    .list.is-plain li {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .list.is-plain .value {
      grid-column: 2;
    }
    .count {
      flex-basis: 100%;
      order: -1;
      margin: 0;
    }
    input.folder {
      width: 100%;
      min-width: 0;
    }
  }
</style>
