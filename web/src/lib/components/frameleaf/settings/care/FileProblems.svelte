<script lang="ts">
  /**
   * Damaged and missing files (FL-1338, after the prototype `settings-v2/care/files.jsx`): every file
   * Frameleaf found a problem with, what it did about it and what is left for the person, in three
   * tabs (Needs you, Fixed for you, Left as they are). Each row opens its What happened sheet
   * (`FileStory`); `?file=<id>` opens one from a link (Things to fix, the Overview, the photo viewer).
   *
   * Every account has the page: a member sees their own files, an administrator the household's too,
   * with a lock instead of another account's picture (Library care never shows one account another's
   * pictures). "What Frameleaf does by itself" holds server settings (`libraryCare.autoRepair`, the
   * same switch as File checks, and `libraryCare.askPhones`), so it is an administrator's only, bound
   * to the settings being edited as Things to fix does. Everyone reads the promise under it.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import FileStory from '$lib/components/frameleaf/settings/care/FileStory.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { lineWords, problemKind } from '$lib/frameleaf/file-steps';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, FileProblemTab, getFileProblems, type FileProblemRowDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAutoFix,
    mdiCellphoneArrowDown,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiImageOffOutline,
    mdiLockOutline,
    mdiMagnify,
    mdiShieldAlertOutline,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  /** The mock's "Show more" shows the next 50. */
  const PAGE_SIZE = 50;
  const TABS = [FileProblemTab.Needs, FileProblemTab.Fixed, FileProblemTab.Kept] as const;
  type List = { items: FileProblemRowDto[]; total: number };

  const isAdmin = $derived(authManager.user.isAdmin);
  const settingsDraft = getSystemConfigDraft();
  /** The switches are server settings: only an administrator, inside the settings page, has them. */
  const care = $derived(isAdmin ? settingsDraft?.draft.libraryCare : undefined);
  const held = $derived(featureFlagsManager.value.configFile);

  const asked = page.url.searchParams.get('tab');
  let tab = $state<FileProblemTab>(TABS.find((value) => value === asked) ?? FileProblemTab.Needs);
  let lists = $state<Record<FileProblemTab, List>>({
    [FileProblemTab.Needs]: { items: [], total: 0 },
    [FileProblemTab.Fixed]: { items: [], total: 0 },
    [FileProblemTab.Kept]: { items: [], total: 0 },
  });
  let loaded = $state(false);
  let failed = $state(false);
  let loadingMore = $state(false);
  let said = $state('');
  /** The problem whose What happened sheet is open, and its row when it was opened from the list. */
  let openId = $state<string | null>(null);
  let opened = $state<FileProblemRowDto>();

  /** Each tab's first page, so their counts are known and switching tabs waits for nothing. */
  const load = async () => {
    try {
      const pages = await Promise.all(TABS.map((value) => getFileProblems({ tab: value, take: PAGE_SIZE })));
      lists = {
        [FileProblemTab.Needs]: pages[0],
        [FileProblemTab.Fixed]: pages[1],
        [FileProblemTab.Kept]: pages[2],
      };
      failed = false;
    } catch {
      failed = true;
    } finally {
      loaded = true;
    }
  };

  onMount(() => {
    void load();
  });

  const showMore = async () => {
    const shown = tab;
    const current = lists[shown];
    loadingMore = true;
    try {
      const next = await getFileProblems({ tab: shown, take: PAGE_SIZE, skip: current.items.length });
      const seen = new Set(current.items.map(({ id }) => id));
      lists[shown] = { items: [...current.items, ...next.items.filter(({ id }) => !seen.has(id))], total: next.total };
    } catch {
      said = $t('frameleaf_files_load_failed');
    } finally {
      loadingMore = false;
    }
  };

  // A link names the file to open: Things to fix, the Overview and the photo viewer use it.
  const fileParam = $derived(page.url.searchParams.get('file'));
  $effect(() => {
    if (fileParam) {
      opened = undefined;
      openId = fileParam;
    }
  });

  const openStory = (row: FileProblemRowDto) => {
    opened = row;
    openId = row.id;
  };
  const closeStory = () => {
    openId = null;
    opened = undefined;
    if (page.url.searchParams.has('file')) {
      // the list stays where it was, and so does focus
      void goto(commandCenterUrl('care', 'files'), { replaceState: true, reset: false });
    }
  };
  const storyDone = (message: string) => {
    said = message;
    void load();
  };

  const needs = $derived(lists[FileProblemTab.Needs].total);
  const fixed = $derived(lists[FileProblemTab.Fixed].total);
  const kept = $derived(lists[FileProblemTab.Kept].total);

  const hero = $derived.by(() => {
    if (needs > 0) {
      return {
        tone: 'warn' as const,
        icon: mdiShieldAlertOutline,
        title: $t('frameleaf_files_hero_needs_title', { values: { count: needs } }),
        body:
          fixed > 0
            ? $t('frameleaf_files_hero_needs_body', { values: { found: needs + fixed, fixed } })
            : $t('frameleaf_files_hero_needs_body_unfixed', { values: { count: needs } }),
      };
    }
    if (fixed > 0) {
      return {
        tone: 'good' as const,
        icon: mdiCheckCircleOutline,
        title: $t('frameleaf_files_hero_clear_title'),
        body: $t('frameleaf_files_hero_clear_body', { values: { count: fixed } }),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCheckCircleOutline,
      title: $t('frameleaf_files_hero_none_title'),
      body: $t('frameleaf_files_hero_none_body'),
    };
  });

  const tabs = $derived([
    { value: FileProblemTab.Needs, label: $t('frameleaf_files_tab_needs', { values: { count: needs } }) },
    { value: FileProblemTab.Fixed, label: $t('frameleaf_files_tab_fixed', { values: { count: fixed } }) },
    { value: FileProblemTab.Kept, label: $t('frameleaf_files_tab_kept', { values: { count: kept } }) },
  ]);
  const list = $derived(lists[tab]);
  const SECTION: Record<FileProblemTab, { title: Translations; description: Translations }> = {
    [FileProblemTab.Needs]: {
      title: 'frameleaf_files_section_needs',
      description: 'frameleaf_files_section_needs_description',
    },
    [FileProblemTab.Fixed]: {
      title: 'frameleaf_files_section_fixed',
      description: 'frameleaf_files_section_fixed_description',
    },
    [FileProblemTab.Kept]: {
      title: 'frameleaf_files_section_kept',
      description: 'frameleaf_files_section_kept_description',
    },
  };

  const when = (value: string) => {
    const words = backupWhen(new Date(value), { locale: $locale });
    return $t(words.key, { values: words.values });
  };

  /** The row's pill, as the mock says it: what was done, or that it needs the person. */
  const pill = (row: FileProblemRowDto): { tone: KitTone; text: string } => {
    switch (problemKind(row)) {
      case 'repaired': {
        return row.partSaved
          ? { tone: 'warn', text: $t('frameleaf_files_state_part_saved') }
          : { tone: 'good', text: $t('frameleaf_files_state_repaired') };
      }
      case 'found': {
        return { tone: 'good', text: $t('frameleaf_files_state_found') };
      }
      case 'kept': {
        return { tone: 'off', text: $t('frameleaf_files_state_kept') };
      }
      case 'missing': {
        return row.fixState === 'waiting-phone'
          ? { tone: 'warn', text: $t('frameleaf_files_state_waiting_phone') }
          : { tone: 'warn', text: $t('frameleaf_files_state_needs') };
      }
      case 'unrepairable': {
        return { tone: 'bad', text: $t('frameleaf_files_state_needs') };
      }
      case 'unchecked': {
        return { tone: 'warn', text: $t('frameleaf_files_state_needs') };
      }
    }
  };

  /** Its one-line story; another account's row also says whose it is to act on. */
  const detailOf = (row: FileProblemRowDto) =>
    [
      lineWords(row, $t),
      row.pictureAllowed ? undefined : $t('frameleaf_files_private_note', { values: { owner: row.ownerName } }),
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  /** A picture that can't be shown (a damaged file never had a preview) leaves the grey tile. */
  const hideBroken = (event: Event) => {
    (event.currentTarget as HTMLImageElement).hidden = true;
  };

  const setRepair = (value: boolean) => {
    const draft = settingsDraft?.draft;
    if (draft?.libraryCare) {
      draft.libraryCare.autoRepair = value;
    }
  };
  const setPhones = (value: boolean) => {
    const draft = settingsDraft?.draft;
    if (draft?.libraryCare) {
      draft.libraryCare.askPhones = value;
    }
  };
</script>

{#snippet picture(row: FileProblemRowDto)}
  {@const kind = problemKind(row)}
  {#if row.pictureAllowed}
    <span
      class="picture"
      class:is-missing={kind === 'missing'}
      class:is-faded={kind === 'unrepairable' || kind === 'unchecked'}
    >
      <img
        src={getAssetMediaUrl({ id: row.assetId, size: AssetMediaSize.Thumbnail, cacheKey: row.updatedAt })}
        alt=""
        loading="lazy"
        onerror={hideBroken}
      />
      {#if kind === 'missing'}<span class="badge"><Icon icon={mdiImageOffOutline} size="12" aria-hidden /></span>{/if}
    </span>
  {:else}
    <!-- Library care never shows one account another's pictures: not even a request for it. -->
    <span class="picture is-private"><Icon icon={mdiLockOutline} size="18" aria-hidden /></span>
  {/if}
{/snippet}

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  <Hero
    tone={loaded && !failed ? hero.tone : 'quiet'}
    icon={failed ? mdiShieldAlertOutline : hero.icon}
    title={!loaded ? $t('frameleaf_care_fix_loading') : failed ? $t('frameleaf_files_load_failed') : hero.title}
    body={loaded && !failed ? hero.body : undefined}
    label={$t('frameleaf_cc_section_files')}
  />

  <!-- The tabs sit at the end of the heading, as mocked, and wrap inside their track on a phone. -->
  <div class="tabbed">
    <Section title={$t(SECTION[tab].title)} description={$t(SECTION[tab].description)}>
      {#snippet action()}
        <SegmentedControl label={$t('frameleaf_files_show')} options={tabs} bind:value={tab} />
      {/snippet}
      {#if loaded && list.items.length === 0}
        <p class="empty">
          {tab === FileProblemTab.Needs ? $t('frameleaf_files_empty_needs') : $t('frameleaf_files_empty')}
        </p>
      {:else if list.items.length > 0}
        <ItemList noMeasure>
          {#each list.items as row (row.id)}
            {@const shown = pill(row)}
            <Item
              name={row.originalFileName}
              detail={detailOf(row)}
              tone={shown.tone}
              status={shown.text}
              note={$t('frameleaf_files_row_library', { values: { owner: row.ownerName, when: when(row.updatedAt) } })}
            >
              {#snippet media()}{@render picture(row)}{/snippet}
              {#snippet action()}
                <Button
                  label={$t('frameleaf_files_what_happened_to', { values: { name: row.originalFileName } })}
                  onclick={() => openStory(row)}
                >
                  {$t('frameleaf_files_what_happened')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
                </Button>
              {/snippet}
            </Item>
          {/each}
        </ItemList>
        {#if list.total > list.items.length}
          <div class="more">
            <Button disabled={loadingMore} onclick={() => void showMore()}>
              {$t('frameleaf_files_show_more', { values: { count: list.total - list.items.length } })}
            </Button>
          </div>
        {/if}
      {/if}
    </Section>
  </div>

  {#if care}
    <Section title={$t('frameleaf_files_auto_title')} description={$t('frameleaf_files_auto_description')}>
      <ItemList>
        <Item
          icon={mdiAutoFix}
          name={$t('frameleaf_care_fc_when_problem_repair_name')}
          detail={care.autoRepair
            ? $t('frameleaf_care_fc_when_problem_repair_on')
            : $t('frameleaf_files_auto_repair_off')}
        >
          {#snippet measure()}
            <Switch
              label={$t('frameleaf_care_fc_when_problem_repair_name')}
              checked={care.autoRepair}
              {held}
              onChange={setRepair}
            />
          {/snippet}
        </Item>
        <Item
          icon={mdiMagnify}
          name={$t('frameleaf_care_fc_when_problem_look_name')}
          detail={$t('frameleaf_care_fc_when_problem_look_detail')}
        >
          {#snippet measure()}
            <!-- Always on: it only looks, and nothing is changed until a copy matches exactly. -->
            <Switch label={$t('frameleaf_care_fc_when_problem_look_name')} checked always />
          {/snippet}
        </Item>
        <Item
          icon={mdiCellphoneArrowDown}
          name={$t('frameleaf_files_auto_phones_name')}
          detail={$t('frameleaf_files_auto_phones_detail')}
        >
          {#snippet measure()}
            <Switch
              label={$t('frameleaf_files_auto_phones_name')}
              checked={care.askPhones}
              {held}
              onChange={setPhones}
            />
          {/snippet}
        </Item>
      </ItemList>
    </Section>
  {/if}

  <!-- The prototype's `Pledge` (care/shared.jsx): an info notice with the shield. -->
  <Notice icon={mdiShieldCheckOutline} title={$t('frameleaf_files_pledge')}>
    {$t('frameleaf_files_pledge_detail')}
  </Notice>

  {#if openId}
    {#key openId}
      <FileStory id={openId} row={opened} onDone={storyDone} onClose={closeStory} />
    {/key}
  {/if}
</KitPage>

<style>
  /* care.css `.care-file-picture`: the file's own picture in its row, 44px like an icon tile. */
  .picture {
    position: relative;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    overflow: hidden;
    color: var(--fl-muted);
    background: var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .picture img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  /* A missing file: only its small preview is left. */
  .picture.is-missing img {
    filter: grayscale(1);
    opacity: 0.55;
  }
  .badge {
    position: absolute;
    right: 3px;
    bottom: 3px;
    display: grid;
    place-items: center;
    padding: 2px;
    color: var(--fl-warning);
    background: var(--fl-panel);
    border-radius: 50%;
  }
  /* A file that can't be repaired: its preview from before, greyed. */
  .picture.is-faded img {
    filter: grayscale(1);
    opacity: 0.4;
  }
  /*
   * The tabs are the Section's action. On a narrow page its heading wraps and the action takes a line
   * of its own; letting it shrink to that line lets the track wrap (KitPage) instead of running off it.
   */
  .tabbed :global(.kit-section > .heading > .action) {
    flex-shrink: 1;
    min-width: 0;
    max-width: 100%;
  }
  .tabbed :global(.segments) {
    flex-wrap: wrap;
    max-width: 100%;
  }
  /* care.css `.care-files-empty` / `.care-files-more`. */
  .empty {
    margin: 0;
    padding: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .more {
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
  }
</style>
