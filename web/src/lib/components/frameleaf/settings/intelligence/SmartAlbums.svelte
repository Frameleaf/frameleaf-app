<script lang="ts">
  /**
   * Search & intelligence › Categories & smart albums (FL-366, after the approved prototype
   * `settings-v2/care/albums.jsx`): albums that fill themselves (`smartAlbums`), and categories of
   * your own (`smartAlbums.rules`). With `?album=<kind>` in the address the page is that one
   * built-in album instead (`SmartAlbum` in the prototype): its name, the words that add a photo and
   * how strict it is, with the two lists and the number under Advanced.
   *
   * "Words that add a photo" is one list over the two the server keeps: a single word is a tag the
   * photo must have (`tagTriggers`), a phrase is a description compared with what the photo looks
   * like (`clipQueries`). Advanced shows and edits the two lists as they are.
   *
   * Left for later (server work): how many photos each album holds and sample pictures, how many
   * people show it and each person hiding an album for themselves (the member view), the count and
   * samples of what a change would add or remove before saving, "Make a category" from this page and
   * "Pick out your best shots", which has no server setting.
   */
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import BackLink from '$lib/components/frameleaf/settings/kit/BackLink.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextArea from '$lib/components/frameleaf/settings/kit/TextArea.svelte';
  import Explain from '$lib/components/frameleaf/settings/intelligence/Explain.svelte';
  import Figure from '$lib/components/frameleaf/settings/intelligence/Figure.svelte';
  import Words from '$lib/components/frameleaf/settings/intelligence/Words.svelte';
  import {
    ALBUM_STRICTNESS,
    choiceOf,
    splitAlbumWords,
    type AlbumStrictness,
  } from '$lib/components/frameleaf/settings/intelligence/presets';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import SmartAlbumReevaluateModal from '$lib/modals/SmartAlbumReevaluateModal.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { ClassificationRuleAction, SmartAlbumBuiltInKind, type AdminConfigSmartAlbumKindDto } from '@frameleaf/sdk';
  import { modalManager, toastManager } from '@frameleaf/ui';
  import {
    mdiAirplane,
    mdiCellphoneScreenshot,
    mdiFileDocumentOutline,
    mdiPaw,
    mdiPineTree,
    mdiShapeOutline,
    mdiSilverwareForkKnife,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Kind = `${SmartAlbumBuiltInKind}`;
  const KINDS: readonly { kind: Kind; icon: string }[] = [
    { kind: SmartAlbumBuiltInKind.Travel, icon: mdiAirplane },
    { kind: SmartAlbumBuiltInKind.Documents, icon: mdiFileDocumentOutline },
    { kind: SmartAlbumBuiltInKind.Food, icon: mdiSilverwareForkKnife },
    { kind: SmartAlbumBuiltInKind.Pets, icon: mdiPaw },
    { kind: SmartAlbumBuiltInKind.Nature, icon: mdiPineTree },
    { kind: SmartAlbumBuiltInKind.Screenshots, icon: mdiCellphoneScreenshot },
  ];

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  // The server always returns these; the DTO marks them optional only because they have defaults.
  const smartAlbums = $derived(settingsDraft.draft.smartAlbums!);
  const savedSmartAlbums = $derived(settingsDraft.baseline.smartAlbums!);
  const rules = $derived(smartAlbums.rules);

  /** The one album this page is about, when the address names one. */
  const album = $derived(KINDS.find(({ kind }) => kind === page.url.searchParams.get('album')));
  const kindConfig = $derived(album ? smartAlbums.builtIn[album.kind] : undefined);
  const savedKindConfig = $derived(album ? savedSmartAlbums.builtIn[album.kind] : undefined);

  const listUrl = commandCenterUrl('intelligence', 'smart-albums');
  const kindName = (kind: Kind, config?: AdminConfigSmartAlbumKindDto) =>
    config?.name.trim() || $t(`admin.smart_albums_kind_${kind}` as Translations);
  const offered = $derived(KINDS.filter(({ kind }) => smartAlbums.builtIn[kind].enabled));
  const list = (names: string[]) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names);

  const hero = $derived.by(() => {
    if (!smartAlbums.enabled) {
      return {
        tone: 'quiet' as const,
        title: $t('frameleaf_intel_albums_off'),
        body: $t('frameleaf_intel_albums_off_body'),
      };
    }
    return {
      tone: offered.length > 0 ? ('good' as const) : ('quiet' as const),
      title: $t('frameleaf_intel_albums_on', { values: { count: offered.length } }),
      body:
        offered.length > 0
          ? $t('frameleaf_intel_albums_on_body', {
              values: { names: list(offered.map(({ kind }) => kindName(kind, smartAlbums.builtIn[kind]))) },
            })
          : $t('frameleaf_intel_albums_none_body'),
    };
  });

  const reevaluate = async (kind?: Kind) => {
    const label = kind ? kindName(kind, smartAlbums.builtIn[kind]) : undefined;
    const result = await modalManager.show(
      SmartAlbumReevaluateModal,
      kind ? { kind: kind as SmartAlbumBuiltInKind, kindLabel: label } : {},
    );
    if (result?.queued) {
      toastManager.primary(
        label
          ? $t('admin.smart_albums_kind_reevaluate_started', { values: { kind: label } })
          : $t('admin.smart_albums_reevaluate_started'),
      );
    } else if (result) {
      toastManager.primary($t('admin.smart_albums_reevaluate_already_in_flight'));
    }
  };

  // One album ───────────────────────────────────────────────────────────────────────────────

  const strictness = $derived<AlbumStrictness | 'custom'>(
    kindConfig ? (choiceOf(ALBUM_STRICTNESS, kindConfig) ?? 'custom') : 'custom',
  );
  const albumChanged = $derived(
    !!kindConfig && !!savedKindConfig && JSON.stringify(kindConfig) !== JSON.stringify(savedKindConfig),
  );
  const lines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const undoAlbum = () => {
    if (album && savedKindConfig) {
      smartAlbums.builtIn[album.kind] = $state.snapshot(savedKindConfig) as AdminConfigSmartAlbumKindDto;
    }
  };
</script>

<KitPage>
  {#if album && kindConfig}
    {@const name = kindName(album.kind, kindConfig)}
    <BackLink href={listUrl} label={$t('frameleaf_intel_albums_title')} />
    <Hero
      tone={kindConfig.enabled && smartAlbums.enabled ? 'good' : 'quiet'}
      icon={album.icon}
      title={kindConfig.enabled
        ? $t('frameleaf_intel_album_offered', { values: { name } })
        : $t('frameleaf_intel_album_not_offered', { values: { name } })}
      body={kindConfig.enabled
        ? $t(`frameleaf_intel_album_what_${album.kind}` as Translations)
        : $t('frameleaf_intel_album_not_offered_body')}
      label={$t('frameleaf_intel_album_status')}
    />

    {#if !smartAlbums.enabled}
      <Notice tone="warn" title={$t('frameleaf_intel_album_all_off')}>
        {$t('frameleaf_intel_album_all_off_body')}
      </Notice>
    {/if}

    <Section title={$t('frameleaf_intel_album_what_goes_in')}>
      <Row label={$t('frameleaf_intel_album_offer')} help={$t('frameleaf_intel_album_offer_help')}>
        <Switch
          label={$t('frameleaf_intel_album_offer')}
          checked={kindConfig.enabled}
          held={disabled}
          onChange={(value) => (kindConfig.enabled = value)}
        />
      </Row>
      {#if kindConfig.enabled}
        <Row label={$t('frameleaf_intel_album_name')} help={$t('frameleaf_intel_album_name_help')}>
          <Field
            label={$t('frameleaf_intel_album_name')}
            value={kindConfig.name}
            {disabled}
            onChange={(value) => (kindConfig.name = value)}
          />
        </Row>
        <Row label={$t('frameleaf_intel_album_words')} help={$t('frameleaf_intel_album_words_help')} />
        <Words
          label={$t('frameleaf_intel_album_words')}
          words={[...kindConfig.tagTriggers, ...kindConfig.clipQueries]}
          {disabled}
          onChange={(words) => {
            const split = splitAlbumWords(words);
            kindConfig.tagTriggers = split.tagTriggers;
            kindConfig.clipQueries = split.clipQueries;
          }}
        />
        <Row
          label={$t('frameleaf_intel_album_strict')}
          help={strictness === 'custom'
            ? $t('frameleaf_intel_album_strict_custom_help', { values: { score: kindConfig.threshold } })
            : $t(`frameleaf_intel_album_strict_${strictness}_help` as Translations, { values: { name } })}
          lead={strictness === 'custom'
            ? $t('frameleaf_intel_custom')
            : $t(`frameleaf_intel_album_strict_${strictness}` as Translations)}
        >
          <SegmentedControl
            label={$t('frameleaf_intel_album_strict')}
            value={strictness}
            {disabled}
            options={[
              ...ALBUM_STRICTNESS.map((choice) => ({
                value: choice.id,
                label: $t(`frameleaf_intel_album_strict_${choice.id}` as Translations),
              })),
              ...(strictness === 'custom' ? [{ value: 'custom', label: $t('frameleaf_intel_custom') }] : []),
            ]}
            onChange={(value) => {
              const choice = ALBUM_STRICTNESS.find((item) => item.id === value);
              if (choice) {
                kindConfig.threshold = choice.values.threshold;
              }
            }}
          />
        </Row>
        {#if albumChanged}
          <Notice tone="info" title={$t('frameleaf_intel_album_change_title')}>
            {$t('frameleaf_intel_album_change_body', { values: { name } })}
            {#snippet action()}
              <Button onclick={undoAlbum}>{$t('frameleaf_intel_undo')}</Button>
            {/snippet}
          </Notice>
        {/if}
        <Row
          label={$t('frameleaf_intel_album_update')}
          help={$t('frameleaf_intel_album_update_help', { values: { name } })}
        >
          <Button disabled={disabled || albumChanged || !smartAlbums.enabled} onclick={() => reevaluate(album.kind)}>
            {$t('frameleaf_intel_album_update_button')}
          </Button>
        </Row>
        <Advanced summary={$t('frameleaf_intel_album_advanced')}>
          <Explain>{$t('frameleaf_intel_album_advanced_explain')}</Explain>
          <Row label={$t('frameleaf_intel_album_tags')} help={$t('frameleaf_intel_album_tags_help')} />
          <TextArea
            label={$t('frameleaf_intel_album_tags')}
            rows={3}
            value={kindConfig.tagTriggers.join('\n')}
            {disabled}
            onChange={(text) => (kindConfig.tagTriggers = lines(text))}
          />
          <Row label={$t('frameleaf_intel_album_looks')} help={$t('frameleaf_intel_album_looks_help')} />
          <TextArea
            label={$t('frameleaf_intel_album_looks')}
            rows={3}
            value={kindConfig.clipQueries.join('\n')}
            {disabled}
            onChange={(text) => (kindConfig.clipQueries = lines(text))}
          />
          <Row label={$t('frameleaf_intel_album_threshold')} help={$t('frameleaf_intel_album_threshold_help')}>
            <Figure
              label={$t('frameleaf_intel_album_threshold')}
              unit={$t('frameleaf_intel_unit_score')}
              min={0.2}
              max={0.4}
              step={0.01}
              value={kindConfig.threshold}
              {disabled}
              onChange={(value) => (kindConfig.threshold = value)}
            />
          </Row>
        </Advanced>
      {/if}
    </Section>
  {:else}
    <Hero
      tone={hero.tone}
      icon={mdiShapeOutline}
      title={hero.title}
      body={hero.body}
      label={$t('frameleaf_intel_albums_status')}
    >
      {#snippet actions()}
        {#if !smartAlbums.enabled}
          <Button variant="primary" {disabled} onclick={() => (smartAlbums.enabled = true)}>
            {$t('frameleaf_intel_turn_on')}
          </Button>
        {/if}
      {/snippet}
    </Hero>

    <Section
      title={$t('frameleaf_intel_albums_section')}
      description={smartAlbums.enabled ? $t('frameleaf_intel_albums_section_description') : undefined}
    >
      <Row label={$t('frameleaf_intel_albums_build')} help={$t('frameleaf_intel_albums_build_help')}>
        <Switch
          label={$t('frameleaf_intel_albums_build')}
          checked={smartAlbums.enabled}
          held={disabled}
          onChange={(value) => (smartAlbums.enabled = value)}
        />
      </Row>
      {#if smartAlbums.enabled}
        <ItemList>
          {#each KINDS as { kind, icon } (kind)}
            {@const config = smartAlbums.builtIn[kind]}
            {@const name = kindName(kind, config)}
            <Item
              {icon}
              off={!config.enabled}
              {name}
              detail={$t(`frameleaf_intel_album_what_${kind}` as Translations)}
              tone={config.enabled ? 'good' : 'off'}
              status={config.enabled ? $t('frameleaf_intel_albums_offered') : $t('frameleaf_intel_albums_not_offered')}
            >
              {#snippet measure()}
                <Switch
                  label={$t('frameleaf_intel_albums_offer', { values: { name } })}
                  checked={config.enabled}
                  held={disabled}
                  onChange={(value) => (config.enabled = value)}
                />
              {/snippet}
              {#snippet action()}
                <a
                  class="open"
                  href={commandCenterUrl('intelligence', 'smart-albums', { album: kind })}
                  aria-label={$t('frameleaf_intel_open_named', { values: { name } })}
                >
                  {$t('frameleaf_intel_open')}
                </a>
              {/snippet}
            </Item>
          {/each}
        </ItemList>
        <Notice tone="info" title={$t('frameleaf_intel_albums_new_photos')}>
          {$t('frameleaf_intel_albums_new_photos_body')}
          {#snippet action()}
            <Button {disabled} onclick={() => reevaluate()}>{$t('frameleaf_intel_albums_update')}</Button>
          {/snippet}
        </Notice>
      {/if}
    </Section>

    {#if rules}
      <Section title={$t('frameleaf_intel_categories_section')}>
        <Row label={$t('frameleaf_intel_categories_suggest')} help={$t('frameleaf_intel_categories_suggest_help')}>
          <Switch
            label={$t('frameleaf_intel_categories_suggest')}
            checked={rules.visualCategories}
            held={disabled}
            onChange={(value) => (rules.visualCategories = value)}
          />
        </Row>
        {#if rules.visualCategories}
          <Row
            label={$t('frameleaf_intel_categories_match')}
            help={rules.defaultAction === ClassificationRuleAction.Tag
              ? $t('frameleaf_intel_categories_match_tag_help')
              : $t('frameleaf_intel_categories_match_review_help')}
          >
            <SegmentedControl
              label={$t('frameleaf_intel_categories_match')}
              value={rules.defaultAction}
              {disabled}
              options={[
                { value: ClassificationRuleAction.Review, label: $t('frameleaf_intel_categories_match_review') },
                { value: ClassificationRuleAction.Tag, label: $t('frameleaf_intel_categories_match_tag') },
              ]}
              onChange={(value) => (rules.defaultAction = value as ClassificationRuleAction)}
            />
          </Row>
        {/if}
      </Section>
    {/if}
  {/if}
</KitPage>

<style>
  /* The kit's quiet "Open" button, as a link so the album page has an address. */
  .open {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    text-decoration: none;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .open:hover {
    border-color: var(--fl-accent);
  }
  .open:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
