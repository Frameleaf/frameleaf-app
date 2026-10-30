<script lang="ts">
  /**
   * Libraries › Folder checks (FL-365; FL-539 after the prototype's `FolderChecks` in
   * `settings-v2/library/folders.jsx`), also at `section=checking`: the state first (when the folders
   * were last checked and what was found, or which one was skipped), then "Check every folder each
   * night" and "Notice new files right away", "A check is not a backup", what each folder skips, and
   * the recent checks (each folder's last scan).
   *
   * No time controls: folder checks run in the overnight schedule (owner decision 2026-10-10), so the
   * stored `scan.cronExpression` is not shown; a custom one set in the configuration file is kept.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { DEFAULT_EXCLUSION_PATTERNS, libraryKey } from '$lib/frameleaf/libraries';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAllLibraries, MediaOperationStatus, scanLibrary, type LibraryResponseDto } from '@frameleaf/sdk';
  import { mdiFolderAlertOutline, mdiFolderOutline, mdiFolderPlusOutline, mdiFolderSyncOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const nightly = $derived(settingsDraft.baseline.library.scan.enabled);

  let folders = $state<LibraryResponseDto[] | null>(null);
  let said = $state('');
  let checking = $state(false);
  const load = async () => {
    try {
      folders = (await getAllLibraries({})).filter((library) => !library.deletedAt);
    } catch {
      folders = [];
    }
  };
  // The Libraries manager above this section adds and removes folders; follow it without a reload.
  onMount(() => {
    void load();
    return eventManager.on({ LibrariesChange: () => void load() });
  });

  const ago = (iso: string) => DateTime.fromISO(iso, { locale: $locale }).toRelative() ?? '';
  const failed = (library: LibraryResponseDto) =>
    !!library.scan &&
    [MediaOperationStatus.Failed, MediaOperationStatus.Cancelled].includes(library.scan.status as MediaOperationStatus);
  const skipped = $derived((folders ?? []).filter((library) => failed(library)));
  const lastChecked = $derived(
    (folders ?? [])
      .map((library) => library.scan?.finishedAt)
      .filter((at): at is string => !!at)
      .sort()
      .at(-1),
  );
  const totals = $derived.by(() => {
    const sum = { added: 0, removed: 0 };
    for (const library of folders ?? []) {
      sum.added += library.scan?.added ?? 0;
      sum.removed += library.scan?.offlined ?? 0;
    }
    return sum;
  });

  const checkAll = async () => {
    checking = true;
    let started = 0;
    for (const library of folders ?? []) {
      try {
        await scanLibrary({ id: library.id });
        started++;
      } catch {
        // a folder that cannot be checked now says so on its own row
      }
    }
    said = $t('frameleaf_checks_started', { values: { count: started } });
    checking = false;
    await load();
  };

  /** What a folder skips, in words: the two recommended choices, and how many more patterns. */
  const skipsOf = (library: LibraryResponseDto) => {
    const recommended = DEFAULT_EXCLUSION_PATTERNS.every((pattern) => library.exclusionPatterns.includes(pattern));
    const more = library.exclusionPatterns.filter((pattern) => !DEFAULT_EXCLUSION_PATTERNS.includes(pattern)).length;
    return {
      status: recommended ? $t('frameleaf_checks_skip_recommended') : $t('frameleaf_checks_skip_own'),
      detail:
        more > 0
          ? $t('frameleaf_checks_skip_more', { values: { count: more } })
          : $t('frameleaf_checks_skip_nothing_more'),
    };
  };
  const duration = (library: LibraryResponseDto) =>
    library.scan?.startedAt && library.scan.finishedAt
      ? Date.parse(library.scan.finishedAt) - Date.parse(library.scan.startedAt)
      : null;
  const tookNote = (finishedAt: string, ms: number | null) =>
    ms === null
      ? ago(finishedAt)
      : ms < 60_000
        ? $t('frameleaf_checks_recent_took_seconds', {
            values: { ago: ago(finishedAt), seconds: Math.min(59, Math.max(1, Math.round(ms / 1000))) },
          })
        : $t('frameleaf_checks_recent_took', { values: { ago: ago(finishedAt), minutes: Math.round(ms / 60_000) } });
  const recent = $derived(
    (folders ?? [])
      .filter((library) => library.scan?.finishedAt)
      .sort((a, b) => (b.scan?.finishedAt ?? '').localeCompare(a.scan?.finishedAt ?? '')),
  );
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />
  {#if folders !== null}
    {#if folders.length === 0}
      <Hero
        label={$t('frameleaf_checks_label')}
        tone="quiet"
        icon={mdiFolderPlusOutline}
        title={$t('frameleaf_checks_none_title')}
        body={$t('frameleaf_checks_none_body')}
      >
        {#snippet actions()}
          <Button variant="primary" onclick={() => goto(commandCenterUrl('libraries', undefined, { new: '1' }))}>
            {$t('frameleaf_libraries_add')}
          </Button>
        {/snippet}
      </Hero>
    {:else}
      <Hero
        label={$t('frameleaf_checks_label')}
        tone={skipped.length > 0 ? 'warn' : 'good'}
        icon={skipped.length > 0 ? mdiFolderAlertOutline : mdiFolderSyncOutline}
        title={skipped.length > 0
          ? $t('frameleaf_checks_skipped_title', { values: { name: skipped[0].name } })
          : nightly
            ? $t('frameleaf_checks_nightly_title')
            : $t('frameleaf_checks_manual_title')}
        body={`${
          lastChecked
            ? $t('frameleaf_checks_last', {
                values: { ago: ago(lastChecked), count: folders.length, added: totals.added, removed: totals.removed },
              })
            : $t('frameleaf_checks_never')
        } ${nightly ? $t('frameleaf_checks_next_tonight') : $t('frameleaf_checks_next_none')}`}
      >
        {#snippet actions()}
          <Button variant={skipped.length > 0 ? 'primary' : 'default'} disabled={checking} onclick={checkAll}>
            {$t('frameleaf_checks_now')}
          </Button>
        {/snippet}
      </Hero>
    {/if}
  {/if}

  <Section title={$t('frameleaf_checks_keeping')}>
    <Row
      label={$t('frameleaf_checks_nightly')}
      help={configToEdit.library.scan.enabled ? $t('frameleaf_checks_nightly_on') : $t('frameleaf_checks_nightly_off')}
    >
      <Switch
        label={$t('frameleaf_checks_nightly')}
        checked={configToEdit.library.scan.enabled}
        held={disabled}
        onChange={(value) => (configToEdit.library.scan.enabled = value)}
      />
    </Row>
    {#if configToEdit.library.scan.enabled}
      <Row label={$t('frameleaf_checks_overnight')} help={$t('frameleaf_checks_overnight_help')}>
        <Button onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}>
          {$t('frameleaf_libraries_checks_overnight_open')}
        </Button>
      </Row>
    {/if}
    <Row
      label={$t('frameleaf_checks_watch')}
      help={configToEdit.library.watch.enabled ? $t('frameleaf_checks_watch_on') : $t('frameleaf_checks_watch_off')}
    >
      <Switch
        label={$t('frameleaf_checks_watch')}
        checked={configToEdit.library.watch.enabled}
        held={disabled}
        onChange={(value) => (configToEdit.library.watch.enabled = value)}
      />
    </Row>
    <Notice title={$t('frameleaf_checks_not_backup')}>
      {$t('frameleaf_checks_not_backup_body')}
      {#snippet action()}
        <Button onclick={() => goto(commandCenterUrl('backups'))}>{$t('frameleaf_checks_open_backup')}</Button>
      {/snippet}
    </Notice>
    <SettingActions keys={['library']} {disabled} />
  </Section>

  {#if folders && folders.length > 0}
    <Section title={$t('frameleaf_checks_skips_title')} description={$t('frameleaf_checks_skips_description')}>
      <ItemList>
        {#each folders as library (library.id)}
          {@const skips = skipsOf(library)}
          <Item
            icon={mdiFolderOutline}
            quiet
            name={library.name}
            detail={skips.detail}
            tone="good"
            status={skips.status}
            note={library.importPaths.join(' · ')}
          >
            {#snippet action()}
              <Button
                label={$t('frameleaf_checks_change_skips', { values: { name: library.name } })}
                onclick={() =>
                  goto(commandCenterUrl('libraries', undefined, { selected: libraryKey(library.id), edit: '1' }))}
              >
                {$t('frameleaf_checks_change')}
              </Button>
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>

    <Section title={$t('frameleaf_checks_recent')}>
      {#if recent.length === 0}
        <p class="hint">{$t('frameleaf_checks_recent_none')}</p>
      {:else}
        <ItemList>
          {#each recent as library (library.id)}
            {@const scan = library.scan!}
            <Item
              icon={failed(library) ? mdiFolderAlertOutline : mdiFolderSyncOutline}
              quiet
              name={library.name}
              detail={failed(library)
                ? $t('frameleaf_checks_recent_skipped')
                : $t('frameleaf_checks_recent_found', {
                    values: { added: scan.added, updated: scan.updated, removed: scan.offlined },
                  })}
              tone={failed(library) ? 'warn' : 'good'}
              status={failed(library)
                ? $t('frameleaf_checks_recent_status_skipped')
                : $t('frameleaf_checks_recent_status_done')}
              note={tookNote(scan.finishedAt!, duration(library))}
            />
          {/each}
        </ItemList>
      {/if}
    </Section>
  {/if}
</KitPage>

<style>
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
