<script lang="ts">
  /**
   * Library care › Tidy up (FL-1470, approved prototype `settings-v2/care/tidy-up.jsx`, FL-1468): memes, receipts,
   * screenshots and other clutter, moved off the timeline to the Archive. Nothing is deleted. Every account opens
   * it for its own photos.
   *
   * One row per kind with a switch and Options (how strict, and Archive automatically, which is off for every
   * kind until the person turns it on). Turning a kind on looks through the library and only suggests; the
   * review is its own page (`tidy-up-review`).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Thumbs from '$lib/components/frameleaf/settings/kit/Thumbs.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import {
    kindName,
    kindWhat,
    strictnessName,
    strictnessSaid,
    TIDY_KINDS,
    TIDY_STRICTNESS,
  } from '$lib/frameleaf/tidy-up';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getTidyUp,
    getTidyUpSuggestions,
    TidyUpKind,
    TidyUpStrictness,
    updateTidyUpKind,
    type TidyUpKindStatusDto,
    type TidyUpStatusDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountOutline,
    mdiArchiveOutline,
    mdiBroom,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiHeartOutline,
    mdiImageSearchOutline,
    mdiLockOutline,
    mdiStarOutline,
  } from '@mdi/js';
  import { goto } from '$app/navigation';
  import { t } from 'svelte-i18n';

  let status = $state<TidyUpStatusDto>();
  let failed = $state(false);
  let busy = $state<string>();
  let said = $state('');
  /** A few of each kind's suggestions, beside its row. */
  let samples = $state<Record<string, string[]>>({});

  const readSamples = async (kinds: TidyUpKindStatusDto[]) => {
    const pairs = await Promise.all(
      kinds
        .filter((kind) => kind.enabled && kind.waiting > 0)
        .map(async (kind) => {
          try {
            const page = await getTidyUpSuggestions({ kind: kind.kind as TidyUpKind, size: 3 });
            return [kind.kind, page.items.map(({ assetId }) => assetId)] as const;
          } catch {
            return [kind.kind, []] as const;
          }
        }),
    );
    samples = Object.fromEntries(pairs);
  };

  const load = async () => {
    try {
      status = await getTidyUp();
      failed = false;
      void readSamples(status.kinds);
    } catch {
      failed = true;
    }
  };
  void load();

  const kinds = $derived(
    TIDY_KINDS.map(({ id, icon }) => ({ icon, ...status?.kinds.find((kind) => kind.kind === id) })).filter(
      (kind): kind is TidyUpKindStatusDto & { icon: string } => !!kind.kind,
    ),
  );
  const visualOff = $derived(kinds.some((kind) => !kind.available));
  const anyOn = $derived(kinds.some((kind) => kind.enabled && kind.available));

  const change = async (
    kind: TidyUpKindStatusDto,
    body: Parameters<typeof updateTidyUpKind>[0]['tidyUpKindUpdateDto'],
  ) => {
    busy = kind.kind;
    const name = $t(kindName(kind.kind));
    try {
      await updateTidyUpKind({ kind: kind.kind as TidyUpKind, tidyUpKindUpdateDto: body });
      if (body.enabled === true) {
        said = $t('frameleaf_tidy_said_on', { values: { name } });
      } else if (body.enabled === false) {
        said = $t('frameleaf_tidy_said_off', { values: { name } });
      } else if (body.automatic) {
        said = $t('frameleaf_tidy_said_automatic', { values: { name } });
      } else {
        said = $t('frameleaf_tidy_said_saved', { values: { name } });
      }
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_tidy_change_failed'));
    } finally {
      busy = undefined;
    }
  };

  // Options: how strict, and Archive automatically.
  let editing = $state<TidyUpKindStatusDto>();
  let strictness = $state<string>('balanced');
  let automatic = $state(false);
  let optionsOpen = $state(false);
  const openOptions = (kind: TidyUpKindStatusDto) => {
    editing = kind;
    strictness = kind.strictness;
    automatic = kind.automatic;
    optionsOpen = true;
  };
  const saveOptions = async () => {
    const kind = editing;
    optionsOpen = false;
    if (!kind) {
      return;
    }
    await change(kind, {
      enabled: kind.enabled ? undefined : true,
      strictness: kind.visual && strictness !== kind.strictness ? (strictness as TidyUpStrictness) : undefined,
      automatic: automatic === kind.automatic ? undefined : automatic,
    });
  };

  const review = (tab: 'waiting' | 'tidied') => goto(commandCenterUrl('care', 'tidy-up-review', { tab }));

  const hero = $derived.by(() => {
    if (failed) {
      return { tone: 'warn' as const, icon: mdiBroom, title: $t('frameleaf_tidy_load_failed') };
    }
    if (!status) {
      return { tone: 'quiet' as const, icon: mdiBroom, title: $t('frameleaf_tidy_loading') };
    }
    if (!anyOn) {
      return {
        tone: 'quiet' as const,
        icon: mdiBroom,
        title: $t('frameleaf_tidy_hero_first'),
        body: $t('frameleaf_tidy_hero_first_body'),
      };
    }
    if (status.waiting > 0) {
      return {
        tone: 'good' as const,
        icon: mdiBroom,
        title: $t('frameleaf_tidy_hero_waiting', { values: { count: status.waiting } }),
        body: $t('frameleaf_tidy_hero_waiting_body'),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCheckCircleOutline,
      title: $t('frameleaf_tidy_hero_none'),
      body: $t('frameleaf_tidy_hero_none_body'),
    };
  });

  const kept = [
    { icon: mdiHeartOutline, key: 'frameleaf_tidy_kept_favourites' },
    { icon: mdiStarOutline, key: 'frameleaf_tidy_kept_stars' },
    { icon: mdiLockOutline, key: 'frameleaf_tidy_kept_locked' },
    { icon: mdiAccountOutline, key: 'frameleaf_tidy_kept_people' },
  ] as const;

  const rowStatus = (kind: TidyUpKindStatusDto) => {
    if (!kind.available) {
      return $t('frameleaf_tidy_needs_visual');
    }
    if (!kind.enabled) {
      return $t('frameleaf_tidy_off');
    }
    if (kind.automatic) {
      return $t('frameleaf_tidy_automatic_on');
    }
    return kind.waiting > 0
      ? $t('frameleaf_tidy_to_review', { values: { count: kind.waiting } })
      : $t('frameleaf_tidy_nothing_waiting');
  };
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_tidy_title')}>
    {#snippet actions()}
      {#if failed}
        <Button variant="primary" onclick={() => void load()}>{$t('frameleaf_tidy_try_again')}</Button>
      {:else if status && status.waiting > 0}
        <Button variant="primary" onclick={() => review('waiting')}>{$t('frameleaf_tidy_review')}</Button>
      {/if}
    {/snippet}
  </Hero>

  {#if visualOff}
    <Notice tone="warn" icon={mdiImageSearchOutline} title={$t('frameleaf_tidy_visual_off')}>
      {$t('frameleaf_tidy_visual_off_body')}
      {#snippet action()}
        <Button onclick={() => goto(commandCenterUrl('intelligence', 'smart-search'))}>
          {$t('frameleaf_tidy_visual_search')}
        </Button>
      {/snippet}
    </Notice>
  {/if}

  {#if status}
    <Section title={$t('frameleaf_tidy_what')} description={$t('frameleaf_tidy_what_description')}>
      <ItemList>
        {#each kinds as kind (kind.kind)}
          {@const on = kind.enabled && kind.available}
          <Item
            icon={kind.icon}
            off={!on}
            name={$t(kindName(kind.kind))}
            detail={$t(kindWhat(kind.kind))}
            tone={on ? (kind.waiting > 0 && !kind.automatic ? 'warn' : 'good') : 'off'}
            status={rowStatus(kind)}
            note={on ? $t(strictnessName(kind.strictness)) : undefined}
          >
            {#snippet measure()}
              <div class="measure">
                {#if on}
                  <Thumbs ids={samples[kind.kind] ?? []} label={$t(kindName(kind.kind))} />
                {/if}
                <Switch
                  label={$t('frameleaf_tidy_look_for', { values: { name: $t(kindName(kind.kind)) } })}
                  checked={on}
                  held={!kind.available || busy === kind.kind}
                  onChange={(checked) => void change(kind, { enabled: checked })}
                />
              </div>
            {/snippet}
            {#snippet action()}
              <Button
                disabled={!kind.available}
                label={$t('frameleaf_tidy_options_named', { values: { name: $t(kindName(kind.kind)) } })}
                onclick={() => openOptions(kind)}>{$t('frameleaf_tidy_options')}</Button
              >
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>

    <Section title={$t('frameleaf_tidy_kept_title')} description={$t('frameleaf_tidy_kept_description')}>
      <ul class="kept">
        {#each kept as row (row.key)}
          <li><Icon icon={row.icon} size="20" aria-hidden />{$t(row.key)}</li>
        {/each}
      </ul>
    </Section>

    <Section title={$t('frameleaf_tidy_tidied_away')}>
      <ItemList>
        <Item
          icon={mdiArchiveOutline}
          name={$t('frameleaf_tidy_tidied_away')}
          detail={$t('frameleaf_tidy_tidied_away_detail')}
          status={$t('frameleaf_tidy_photos', { values: { count: status.tidiedAway } })}
          note={$t('frameleaf_tidy_tidied_away_note')}
        >
          {#snippet action()}
            <Button label={$t('frameleaf_tidy_open_tidied_away')} onclick={() => review('tidied')}>
              {$t('frameleaf_tidy_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
            </Button>
          {/snippet}
        </Item>
      </ItemList>
    </Section>
  {/if}
</KitPage>

{#if editing}
  <Dialog
    bind:open={optionsOpen}
    title={$t(kindName(editing.kind))}
    closeLabel={$t('frameleaf_tidy_close')}
    size="medium"
    onClosed={() => (editing = undefined)}
  >
    <p class="lead">{$t(kindWhat(editing.kind))}</p>
    {#if editing.visual}
      <Row label={$t('frameleaf_tidy_how_strict')} help={$t(strictnessSaid(strictness))}>
        <SegmentedControl
          label={$t('frameleaf_tidy_how_strict')}
          value={strictness}
          options={TIDY_STRICTNESS.map((id) => ({ value: id, label: $t(strictnessName(id)) }))}
          onChange={(value) => (strictness = value)}
        />
      </Row>
    {/if}
    <Row
      label={$t('frameleaf_tidy_automatic')}
      help={automatic ? $t('frameleaf_tidy_automatic_help_on') : $t('frameleaf_tidy_automatic_help_off')}
    >
      <Switch
        label={$t('frameleaf_tidy_automatic')}
        checked={automatic}
        onChange={(checked) => (automatic = checked)}
      />
    </Row>
    {#if automatic && !editing.automatic && editing.waiting > 0}
      <Notice tone="info" title={$t('frameleaf_tidy_automatic_waiting', { values: { count: editing.waiting } })}>
        {$t('frameleaf_tidy_automatic_waiting_body')}
      </Notice>
    {/if}
    {#snippet actions()}
      <Button onclick={() => (optionsOpen = false)}>{$t('frameleaf_tidy_cancel')}</Button>
      <Button variant="primary" onclick={() => void saveOptions()}>{$t('frameleaf_tidy_save')}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .measure {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .kept {
    display: grid;
    gap: var(--fl-space-3);
    margin: 0 0 var(--fl-space-5);
    padding: 0;
    list-style: none;
  }
  .kept li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .kept :global(svg) {
    flex: none;
    color: var(--fl-muted);
  }
  .lead {
    margin: 0 0 var(--fl-space-4);
    color: var(--fl-muted);
  }
</style>
