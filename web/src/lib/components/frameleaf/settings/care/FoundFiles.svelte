<script lang="ts">
  /**
   * Photos found on the drive (FL-1533, after the prototype `settings-v2/care/found-files.jsx`): the files
   * that were on the drive but in nobody's library, what each turned out to be and what Frameleaf did with
   * it, as pictures. Four tabs: Needs you (whole groups with one decision each), Put back, Added and Spare
   * copies. A tile opens the file's story (`FoundFileStory`), where what was done can be undone;
   * `?file=<id>` opens one from a link and `?tab=` chooses the tab. After an Undo the line that says so
   * offers to sort the file again (FL-1579): a file left alone is in no tab, so that line and its story
   * are where it can be asked for. The files that won't open can be downloaded in one archive.
   *
   * An administrator's page (the server sorts every account's folders), opened from File checks and kept
   * out of the navigation. Another account's picture is never shown, and never asked for: a lock stands
   * in its place. The two switches are server settings (`libraryCare.putBackFoundFiles`,
   * `libraryCare.clearGonePreviews`), bound to the settings being edited.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import FoundFileStory from '$lib/components/frameleaf/settings/care/FoundFileStory.svelte';
  import {
    foundArchiveUrl,
    foundPicture,
    sortedAgainWords,
    WONT_OPEN_ARCHIVE,
  } from '$lib/components/frameleaf/settings/care/found-files';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    deleteSpareFoundFiles,
    FoundFileDecision,
    FoundFileOutcome,
    FoundFileReason,
    getFoundFiles,
    getFoundFilesSummary,
    getIntegrityOverview,
    IntegrityReport,
    resolveFoundFiles,
    searchUsersAdmin,
    sortFoundFileAgain,
    type FoundFileGroupDto,
    type FoundFileResponseDto,
    type FoundFilesSummaryResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountAlertOutline,
    mdiCheckCircleOutline,
    mdiFileAlertOutline,
    mdiFileDocumentEditOutline,
    mdiFileOutline,
    mdiFolderAccountOutline,
    mdiImageSearchOutline,
    mdiImageSizeSelectLarge,
    mdiImageSyncOutline,
    mdiLockOutline,
    mdiPauseCircleOutline,
    mdiShieldAlertOutline,
    mdiShieldCheckOutline,
    mdiSync,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  const PAGE_SIZE = 60;
  /** How many of a group's pictures its strip shows. */
  const STRIP = 5;
  type Tab = 'needs' | 'back' | 'added' | 'spare';
  const TABS: Tab[] = ['needs', 'back', 'added', 'spare'];
  type Listed = Exclude<Tab, 'needs'>;
  const OUTCOME: Record<Listed, FoundFileOutcome> = {
    back: FoundFileOutcome.Back,
    added: FoundFileOutcome.Added,
    spare: FoundFileOutcome.Spare,
  };
  type List = { items: FoundFileResponseDto[]; nextCursor: string | null };
  const none = (): List => ({ items: [], nextCursor: null });

  const settingsDraft = getSystemConfigDraft();
  const care = $derived(settingsDraft?.draft.libraryCare);
  const held = $derived(featureFlagsManager.value.configFile);

  const asked = page.url.searchParams.get('tab');
  let tab = $state<Tab>(TABS.find((value) => value === asked) ?? 'needs');
  let summary = $state<FoundFilesSummaryResponseDto>();
  let lists = $state<Record<Listed, List>>({ back: none(), added: none(), spare: none() });
  /** A group's files, by its key: the first few for its strip, all of them once "See all" was chosen. */
  let groupFiles = $state<Record<string, List>>({});
  let expanded = $state<Record<string, boolean>>({});
  /** The account chosen for a folder no account uses, by group key. */
  let chosen = $state<Record<string, string>>({});
  let users = $state<{ id: string; name: string }[]>([]);
  let sorting = $state(false);
  let loaded = $state(false);
  let failed = $state(false);
  let working = $state(false);
  let said = $state('');
  let openId = $state<string | null>(null);
  let asking = $state(false);
  /** FL-1579: the file an Undo left alone, offered again by the line that says it was undone. */
  let offer = $state<{ id: string; name: string; message: string } | null>(null);

  const groupKey = (group: FoundFileGroupDto) => [group.reason, group.ownerId ?? '', group.folder ?? ''].join('|');
  const filesOf = (group: FoundFileGroupDto, size: number, cursor?: string) =>
    getFoundFiles({
      outcome: FoundFileOutcome.Needs,
      reason: group.reason,
      folder: group.folder ?? undefined,
      ownerId: group.ownerId ?? undefined,
      size,
      cursor,
    });

  const load = async () => {
    try {
      const [counts, back, added, spare] = await Promise.all([
        getFoundFilesSummary(),
        getFoundFiles({ outcome: FoundFileOutcome.Back, size: PAGE_SIZE }),
        getFoundFiles({ outcome: FoundFileOutcome.Added, size: PAGE_SIZE }),
        getFoundFiles({ outcome: FoundFileOutcome.Spare, size: PAGE_SIZE }),
      ]);
      summary = counts;
      lists = { back, added, spare };
      const strips = await Promise.all(counts.groups.map((group) => filesOf(group, STRIP)));
      groupFiles = Object.fromEntries(counts.groups.map((group, index) => [groupKey(group), strips[index]]));
      expanded = {};
      failed = false;
    } catch {
      failed = true;
    } finally {
      loaded = true;
    }
  };

  onMount(() => {
    void load();
    // names for "whose library", and whether the check is still going: the page works without either
    searchUsersAdmin({ withDeleted: false })
      .then((found) => (users = found.map(({ id, name }) => ({ id, name }))))
      .catch(() => {});
    getIntegrityOverview()
      .then((overview) => (sorting = overview.running.some(({ type }) => type === IntegrityReport.UntrackedFile)))
      .catch(() => {});
  });

  const nameOf = (id: string | null) => users.find((user) => user.id === id)?.name;
  const size = (bytes: number) => getByteUnitString(bytes, $locale);
  const when = (value: string) => {
    const words = backupWhen(new Date(value), { locale: $locale });
    return $t(words.key, { values: words.values });
  };

  const fileParam = $derived(page.url.searchParams.get('file'));
  $effect(() => {
    if (fileParam) {
      openId = fileParam;
    }
  });
  const closeStory = () => {
    openId = null;
    if (page.url.searchParams.has('file')) {
      void goto(commandCenterUrl('care', 'found-files'), { replaceState: true, reset: false });
    }
  };
  const storyDone = (message: string, left?: { id: string; name: string }) => {
    said = message;
    offer = left ? { ...left, message } : null;
    void load();
  };
  /** Only the line that says a file was undone offers it; any later line does not. */
  const offered = $derived(offer && offer.message === said ? offer : null);
  const sortAgain = async () => {
    if (!offered) {
      return;
    }
    const { id, name } = offered;
    working = true;
    try {
      const sorted = await sortFoundFileAgain({ id });
      said = $t(sortedAgainWords(sorted.outcome), { values: { name } });
    } catch {
      said = $t('frameleaf_found_failed');
    } finally {
      offer = null;
      working = false;
      await load();
    }
  };

  const back = $derived(summary?.back ?? 0);
  const added = $derived(summary?.added ?? 0);
  const spare = $derived(summary?.spare ?? 0);
  const needs = $derived(summary?.needs ?? 0);
  const photos = $derived(back + added);
  const found = $derived(photos + spare + needs + (summary?.left ?? 0));
  const tidied = $derived(summary?.tidied);

  const hero = $derived.by(() => {
    if (found === 0) {
      return sorting
        ? {
            tone: 'good' as const,
            icon: mdiSync,
            title: $t('frameleaf_found_hero_checking_title'),
            body: $t('frameleaf_found_hero_checking_body'),
          }
        : {
            tone: 'good' as const,
            icon: mdiCheckCircleOutline,
            title: $t('frameleaf_found_hero_none_title'),
            body: $t('frameleaf_found_hero_none_body'),
          };
    }
    if (sorting) {
      return {
        tone: 'good' as const,
        icon: mdiSync,
        title: $t('frameleaf_found_hero_sorting_title'),
        body: $t('frameleaf_found_hero_sorting_body', { values: { count: found } }),
      };
    }
    if (needs === 0) {
      return {
        tone: 'good' as const,
        icon: mdiCheckCircleOutline,
        title: $t('frameleaf_found_hero_clear_title'),
        body: $t('frameleaf_found_hero_clear_body', { values: { found, photos } }),
      };
    }
    return {
      tone: 'warn' as const,
      icon: mdiImageSearchOutline,
      title:
        photos > 0
          ? $t('frameleaf_found_hero_needs_title', { values: { count: photos } })
          : $t('frameleaf_found_hero_needs_title_none', { values: { count: needs } }),
      body: $t('frameleaf_found_hero_needs_body', { values: { found, needs } }),
    };
  });

  const tabs = $derived([
    { value: 'needs', label: $t('frameleaf_found_tab_needs', { values: { count: needs } }) },
    { value: 'back', label: $t('frameleaf_found_tab_back', { values: { count: back } }) },
    { value: 'added', label: $t('frameleaf_found_tab_added', { values: { count: added } }) },
    { value: 'spare', label: $t('frameleaf_found_tab_spare', { values: { count: spare } }) },
  ]);
  const SECTION: Record<Tab, { title: Translations; description: Translations }> = {
    needs: { title: 'frameleaf_found_section_needs', description: 'frameleaf_found_section_needs_description' },
    back: { title: 'frameleaf_found_section_back', description: 'frameleaf_found_section_back_description' },
    added: { title: 'frameleaf_found_section_added', description: 'frameleaf_found_section_added_description' },
    spare: { title: 'frameleaf_found_section_spare', description: 'frameleaf_found_section_spare_description' },
  };
  const totals = $derived<Record<Listed, number>>({ back, added, spare });

  const showMore = async (which: Listed) => {
    const current = lists[which];
    if (!current.nextCursor) {
      return;
    }
    working = true;
    try {
      const next = await getFoundFiles({ outcome: OUTCOME[which], size: PAGE_SIZE, cursor: current.nextCursor });
      lists[which] = { items: [...current.items, ...next.items], nextCursor: next.nextCursor };
    } catch {
      said = $t('frameleaf_files_load_failed');
    } finally {
      working = false;
    }
  };

  /** "See all": the group's files as a grid, a page at a time. */
  const seeGroup = async (group: FoundFileGroupDto) => {
    const key = groupKey(group);
    const current = groupFiles[key] ?? none();
    working = true;
    try {
      const next = expanded[key]
        ? await filesOf(group, PAGE_SIZE, current.nextCursor ?? undefined)
        : await filesOf(group, PAGE_SIZE);
      groupFiles[key] = expanded[key]
        ? { items: [...current.items, ...next.items], nextCursor: next.nextCursor }
        : next;
      expanded[key] = true;
    } catch {
      said = $t('frameleaf_files_load_failed');
    } finally {
      working = false;
    }
  };

  /** One decision for a whole group. The server works through it a batch at a time. */
  const decide = async (group: FoundFileGroupDto, ownerId?: string) => {
    working = true;
    const done = { back: 0, added: 0, spare: 0, waiting: 0, skipped: 0 };
    try {
      let cursor: string | undefined;
      do {
        const step = await resolveFoundFiles({
          foundFilesResolveDto: {
            reason: group.reason as unknown as FoundFileDecision,
            folder: group.folder ?? undefined,
            ownerId: ownerId ?? group.ownerId ?? undefined,
            cursor,
          },
        });
        for (const key of ['back', 'added', 'spare', 'waiting', 'skipped'] as const) {
          done[key] += step[key];
        }
        cursor = step.nextCursor ?? undefined;
      } while (cursor);
      const left = done.waiting + done.skipped;
      said =
        $t('frameleaf_found_decided', { values: { count: done.back + done.added } }) +
        (done.spare > 0 ? ' ' + $t('frameleaf_found_decided_spare', { values: { count: done.spare } }) : '') +
        (left > 0 ? ' ' + $t('frameleaf_found_decided_left', { values: { count: left } }) : '');
    } catch {
      said = $t('frameleaf_found_failed');
    } finally {
      working = false;
      await load();
    }
  };

  const deleteSpares = async () => {
    asking = false;
    working = true;
    const done = { deleted: 0, freedBytes: 0, kept: 0 };
    try {
      let cursor: string | undefined;
      do {
        const step = await deleteSpareFoundFiles({ foundFilesDeleteSpareDto: { cursor } });
        done.deleted += step.deleted;
        done.freedBytes += step.freedBytes;
        done.kept += step.kept;
        cursor = step.nextCursor ?? undefined;
      } while (cursor);
      said =
        $t('frameleaf_found_spare_deleted', { values: { count: done.deleted, size: size(done.freedBytes) } }) +
        (done.kept > 0 ? ' ' + $t('frameleaf_found_spare_kept', { values: { count: done.kept } }) : '');
    } catch {
      said = $t('frameleaf_found_failed');
    } finally {
      working = false;
      await load();
    }
  };

  const groupWords = (group: FoundFileGroupDto) => {
    const values = { count: group.count, size: size(group.sizeInBytes), owner: nameOf(group.ownerId) ?? '' };
    switch (group.reason) {
      case FoundFileReason.NoOwner: {
        return {
          icon: mdiFolderAccountOutline,
          title: $t('frameleaf_found_group_no_owner', { values }),
          detail: $t('frameleaf_found_group_no_owner_detail', { values: { ...values, folder: group.folder ?? '' } }),
        };
      }
      case FoundFileReason.WontOpen: {
        return {
          icon: mdiFileAlertOutline,
          title: $t('frameleaf_found_group_wont_open', { values }),
          detail: $t('frameleaf_found_group_wont_open_detail', { values }),
        };
      }
      case FoundFileReason.OverLimit: {
        return {
          icon: mdiAccountAlertOutline,
          title: values.owner
            ? $t('frameleaf_found_group_over_limit', { values })
            : $t('frameleaf_found_group_over_limit_unnamed', { values }),
          detail: $t('frameleaf_found_group_over_limit_detail', { values }),
        };
      }
      case FoundFileReason.Asked: {
        return {
          icon: mdiPauseCircleOutline,
          title: $t('frameleaf_found_group_asked', { values }),
          detail: $t('frameleaf_found_group_asked_detail', { values }),
        };
      }
    }
  };

  const tileLine = (file: FoundFileResponseDto) =>
    file.outcome === FoundFileOutcome.Spare || file.outcome === FoundFileOutcome.Needs
      ? size(file.sizeInBytes)
      : when(file.sortedAt);

  const hideBroken = (event: Event) => {
    (event.currentTarget as HTMLImageElement).hidden = true;
  };

  const setPutBack = (value: boolean) => {
    const draft = settingsDraft?.draft;
    if (draft?.libraryCare) {
      draft.libraryCare.putBackFoundFiles = value;
    }
  };
  const setClearPreviews = (value: boolean) => {
    const draft = settingsDraft?.draft;
    if (draft?.libraryCare) {
      draft.libraryCare.clearGonePreviews = value;
    }
  };
</script>

{#snippet picture(file: FoundFileResponseDto)}
  {@const src = foundPicture(file)}
  {#if !file.viewable}
    <!-- Library care never shows one account another's pictures: not even a request for it. -->
    <span class="picture is-private">
      <Icon icon={mdiLockOutline} size="24" aria-hidden />
      <span>
        {nameOf(file.ownerId)
          ? $t('frameleaf_found_private', { values: { owner: nameOf(file.ownerId) } })
          : $t('frameleaf_found_private_unnamed')}
      </span>
    </span>
  {:else}
    <span class="picture">
      <Icon icon={mdiFileOutline} size="24" aria-hidden />
      {#if src}<img {src} alt="" loading="lazy" onerror={hideBroken} />{/if}
    </span>
  {/if}
{/snippet}

{#snippet grid(files: FoundFileResponseDto[])}
  <ul class="grid">
    {#each files as file (file.id)}
      <li>
        <button
          type="button"
          class="tile"
          aria-label={$t('frameleaf_files_what_happened_to', { values: { name: file.fileName } })}
          onclick={() => (openId = file.id)}
        >
          {@render picture(file)}
          <strong>{file.fileName}</strong>
          <small>{tileLine(file)}</small>
        </button>
      </li>
    {/each}
  </ul>
{/snippet}

<KitPage>
  <Said
    message={said}
    onDismiss={() => (said = '')}
    actionLabel={offered ? $t('frameleaf_found_again') : undefined}
    onAction={() => void sortAgain()}
    actionDisabled={working}
  />

  <Hero
    tone={loaded && !failed ? hero.tone : 'quiet'}
    icon={failed ? mdiShieldAlertOutline : hero.icon}
    title={!loaded ? $t('frameleaf_care_fix_loading') : failed ? $t('frameleaf_files_load_failed') : hero.title}
    body={loaded && !failed ? hero.body : undefined}
    label={$t('frameleaf_cc_section_found_files')}
  />

  <div class="tabbed">
    <Section title={$t(SECTION[tab].title)} description={$t(SECTION[tab].description)}>
      {#snippet action()}
        <SegmentedControl label={$t('frameleaf_files_show')} options={tabs} bind:value={tab} />
      {/snippet}
      {#if !loaded || failed}
        <!-- the hero says so -->
      {:else if tab === 'needs'}
        {#if !summary || summary.groups.length === 0}
          <p class="empty">{$t('frameleaf_found_empty_needs')}</p>
        {:else}
          <ul class="groups">
            {#each summary.groups as group (groupKey(group))}
              {@const key = groupKey(group)}
              {@const words = groupWords(group)}
              {@const files = groupFiles[key] ?? none()}
              {@const shown = files.items.filter((file) => file.viewable && foundPicture(file))}
              <li class="group">
                <span class="group-icon"><Icon icon={words.icon} size="20" aria-hidden /></span>
                <div class="group-main">
                  <strong>{words.title}</strong>
                  <span>{words.detail}</span>
                  {#if expanded[key]}
                    {@render grid(files.items)}
                  {:else if shown.length > 0}
                    <div class="strip" aria-hidden="true">
                      {#each shown.slice(0, STRIP) as file (file.id)}
                        <img src={foundPicture(file)} alt="" loading="lazy" onerror={hideBroken} />
                      {/each}
                      {#if group.count > shown.length}<span>+{group.count - Math.min(shown.length, STRIP)}</span>{/if}
                    </div>
                  {/if}
                  <div class="choices">
                    {#if group.reason === FoundFileReason.NoOwner}
                      <Select
                        label={$t('frameleaf_found_whose')}
                        value={chosen[key] ?? ''}
                        options={[
                          { value: '', label: $t('frameleaf_found_whose_choose') },
                          ...users.map((user) => ({
                            value: user.id,
                            label: $t('frameleaf_found_whose_library', { values: { owner: user.name } }),
                          })),
                        ]}
                        disabled={working}
                        onChange={(value) => (chosen[key] = value)}
                      />
                      <Button
                        variant="primary"
                        disabled={working || (chosen[key] ?? '') === ''}
                        onclick={() => void decide(group, chosen[key])}
                      >
                        {$t('frameleaf_found_add', { values: { count: group.count } })}
                      </Button>
                    {:else if group.reason === FoundFileReason.OverLimit}
                      <Button variant="primary" disabled={working} onclick={() => void decide(group)}>
                        {$t('frameleaf_found_add_anyway')}
                      </Button>
                      {#if group.ownerId}
                        <Button onclick={() => void goto(Route.viewUser({ id: group.ownerId! }))}>
                          {nameOf(group.ownerId)
                            ? $t('frameleaf_found_change_limit', { values: { owner: nameOf(group.ownerId) } })
                            : $t('frameleaf_found_change_limit_unnamed')}
                        </Button>
                      {/if}
                    {:else if group.reason === FoundFileReason.Asked}
                      <Button variant="primary" disabled={working} onclick={() => void decide(group)}>
                        {$t('frameleaf_found_put_back_now', { values: { count: group.count } })}
                      </Button>
                    {:else if group.reason === FoundFileReason.WontOpen && files.items.some((file) => file.viewable)}
                      <!-- Another account's files are never sent, so they are not offered either. -->
                      <Button onclick={() => downloadUrl(foundArchiveUrl(group), WONT_OPEN_ARCHIVE)}>
                        {$t('frameleaf_found_download_them')}
                      </Button>
                    {/if}
                    {#if !expanded[key] || files.nextCursor}
                      <Button disabled={working} onclick={() => void seeGroup(group)}>
                        {expanded[key]
                          ? $t('frameleaf_found_show_more')
                          : $t('frameleaf_found_see_all', { values: { count: group.count } })}
                      </Button>
                    {/if}
                  </div>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        {@const list = lists[tab]}
        {#if list.items.length === 0}
          <p class="empty">{$t('frameleaf_found_empty')}</p>
        {:else}
          {@render grid(list.items)}
          <div class="foot">
            {#if list.nextCursor}
              <Button disabled={working} onclick={() => void showMore(tab as Listed)}>
                {$t('frameleaf_files_show_more', {
                  values: { count: Math.max(totals[tab] - list.items.length, 0) },
                })}
              </Button>
            {/if}
            {#if tab === 'spare'}
              <Button variant="danger" disabled={working} onclick={() => (asking = true)}>
                {$t('frameleaf_found_spare_delete', { values: { count: spare } })}
              </Button>
            {/if}
          </div>
        {/if}
      {/if}
    </Section>
  </div>

  {#if tidied && tidied.previews + tidied.sidecars > 0}
    <Section title={$t('frameleaf_found_tidied_title')} description={$t('frameleaf_found_tidied_description')}>
      <ItemList>
        {#if tidied.previews > 0}
          <Item
            icon={mdiImageSizeSelectLarge}
            quiet
            name={$t('frameleaf_found_tidied_previews', { values: { count: tidied.previews } })}
            detail={$t('frameleaf_found_tidied_previews_detail')}
            tone="good"
            status={$t('frameleaf_found_tidied_previews_status')}
            note={$t('frameleaf_found_tidied_previews_note', { values: { size: size(tidied.previewSizeInBytes) } })}
          />
        {/if}
        {#if tidied.sidecars > 0}
          <Item
            icon={mdiFileDocumentEditOutline}
            quiet
            name={$t('frameleaf_found_tidied_sidecars', { values: { count: tidied.sidecars } })}
            detail={$t('frameleaf_found_tidied_sidecars_detail')}
            tone="good"
            status={$t('frameleaf_found_tidied_sidecars_status')}
            note={$t('frameleaf_found_tidied_sidecars_note')}
          />
        {/if}
      </ItemList>
    </Section>
  {/if}

  {#if care}
    <Section title={$t('frameleaf_files_auto_title')} description={$t('frameleaf_found_auto_description')}>
      <ItemList>
        <Item
          icon={mdiImageSyncOutline}
          name={$t('frameleaf_found_auto_put_back_name')}
          detail={(care.putBackFoundFiles ?? true)
            ? $t('frameleaf_found_auto_put_back_on')
            : $t('frameleaf_found_auto_put_back_off')}
        >
          {#snippet measure()}
            <Switch
              label={$t('frameleaf_found_auto_put_back_name')}
              checked={care.putBackFoundFiles ?? true}
              {held}
              onChange={setPutBack}
            />
          {/snippet}
        </Item>
        <Item
          icon={mdiImageSizeSelectLarge}
          name={$t('frameleaf_found_auto_previews_name')}
          detail={$t('frameleaf_found_auto_previews_detail')}
        >
          {#snippet measure()}
            <Switch
              label={$t('frameleaf_found_auto_previews_name')}
              checked={care.clearGonePreviews ?? true}
              {held}
              onChange={setClearPreviews}
            />
          {/snippet}
        </Item>
      </ItemList>
    </Section>
  {/if}

  <Notice icon={mdiShieldCheckOutline} title={$t('frameleaf_found_pledge')}>
    {$t('frameleaf_found_pledge_detail')}
  </Notice>

  {#if openId}
    {#key openId}
      <FoundFileStory id={openId} {users} onDone={storyDone} onClose={closeStory} />
    {/key}
  {/if}

  {#if asking}
    <Dialog
      title={$t('frameleaf_found_spare_ask_title', { values: { count: spare } })}
      closeLabel={$t('close')}
      bind:open={asking}
    >
      <p class="ask">{$t('frameleaf_found_spare_ask_body')}</p>
      <p class="ask is-quiet">
        {$t('frameleaf_found_spare_ask_note', { values: { size: size(summary?.spareSizeInBytes ?? 0) } })}
      </p>
      {#snippet actions()}
        <Button initialFocus onclick={() => (asking = false)}>{$t('cancel')}</Button>
        <Button variant="danger" onclick={() => void deleteSpares()}>
          {$t('frameleaf_found_spare_ask_confirm', { values: { count: spare } })}
        </Button>
      {/snippet}
    </Dialog>
  {/if}
</KitPage>

<style>
  /* care.css `.care-found-grid`: the photos first, as a grid of tiles. */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: var(--fl-space-4);
    margin: 0;
    padding: 0 0 var(--fl-space-4);
    list-style: none;
  }
  .tile {
    display: grid;
    gap: var(--fl-space-1);
    width: 100%;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: start;
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .tile:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
  .tile strong {
    overflow: hidden;
    font-size: var(--fl-font-callout);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  /* care.css `.care-found-picture`. */
  .picture {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    color: var(--fl-muted);
    background: var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .picture img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .picture.is-private {
    place-content: center;
    justify-items: center;
    gap: var(--fl-space-1);
    padding: var(--fl-space-2);
    font-size: var(--fl-font-small);
    text-align: center;
  }
  /* care.css `.care-found-groups`: one decision per group. */
  .groups {
    display: grid;
    gap: var(--fl-space-4);
    margin: 0;
    padding: 0 0 var(--fl-space-4);
    list-style: none;
  }
  .group {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--fl-space-4);
    padding: var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .group-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-muted);
    background: var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .group-main {
    display: grid;
    gap: var(--fl-space-3);
    min-width: 0;
  }
  .group-main > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    overflow-wrap: anywhere;
  }
  .group-main .grid {
    padding-bottom: 0;
  }
  /* care.css `.care-found-strip`. */
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    align-items: center;
  }
  .strip img {
    width: 56px;
    height: 56px;
    object-fit: cover;
    background: var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .strip span {
    padding: 0 var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .choices,
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
    align-items: end;
  }
  .foot {
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
  }
  .tabbed :global(.kit-section > .heading > .action) {
    flex-shrink: 1;
    min-width: 0;
    max-width: 100%;
  }
  .tabbed :global(.segments) {
    flex-wrap: wrap;
    max-width: 100%;
  }
  .empty {
    margin: 0;
    padding: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .ask {
    margin: 0 0 var(--fl-space-3);
  }
  .ask.is-quiet {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  @media (max-width: 520px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .group {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
