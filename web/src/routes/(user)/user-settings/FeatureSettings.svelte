<script lang="ts">
  /**
   * Your preferences › Tools & sidebar (FL-368, after the approved prototype
   * `settings-v2/server/preferences.jsx`; the preferences are FL-77's). One row per tool with what
   * you get, then "Use" and "Show in sidebar" side by side, so the pair of switches each tool had
   * reads as one thing.
   *
   * Each switch is still its own preference: a sidebar switch keeps its value and is only held back
   * while its tool is off. These switches choose tools and navigation; they never restrict access.
   * While an administrator has turned casting off, that switch is held and never sent.
   *
   * The two numbers became a few choices. A number saved outside them (from another app or the API)
   * is shown as "Custom" and kept until another choice replaces it. Changes wait for the Save bar.
   */
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Tell, { type TellRow } from '$lib/components/frameleaf/settings/kit/Tell.svelte';
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import type { AccountPreferenceKey } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { t, type Translations } from 'svelte-i18n';

  type SwitchKey =
    | 'folders.enabled'
    | 'folders.sidebarWeb'
    | 'memories.enabled'
    | 'memories.sidebarWeb'
    | 'people.enabled'
    | 'people.sidebarWeb'
    | 'ratings.enabled'
    | 'sharedLinks.enabled'
    | 'sharedLinks.sidebarWeb'
    | 'tags.enabled'
    | 'tags.sidebarWeb'
    | 'cast.gCastEnabled'
    | 'recentlyAdded.sidebarWeb';

  /** A tool, the switch that turns it on (none: always on) and its sidebar switch (none: no sidebar item). */
  type Tool = { id: string; use?: SwitchKey; sidebar?: SwitchKey };
  const TOOLS: Tool[] = [
    { id: 'folders', use: 'folders.enabled', sidebar: 'folders.sidebarWeb' },
    { id: 'memories', use: 'memories.enabled', sidebar: 'memories.sidebarWeb' },
    { id: 'people', use: 'people.enabled', sidebar: 'people.sidebarWeb' },
    { id: 'shared_links', use: 'sharedLinks.enabled', sidebar: 'sharedLinks.sidebarWeb' },
    { id: 'tags', use: 'tags.enabled', sidebar: 'tags.sidebarWeb' },
    { id: 'ratings', use: 'ratings.enabled' },
    { id: 'cast', use: 'cast.gCastEnabled' },
    { id: 'recent', sidebar: 'recentlyAdded.sidebarWeb' },
  ];

  const keys: AccountPreferenceKey[] = [
    'folders.enabled',
    'folders.sidebarWeb',
    'memories.enabled',
    'memories.sidebarWeb',
    'memories.duration',
    'people.enabled',
    'people.sidebarWeb',
    'people.minimumFaces',
    'ratings.enabled',
    'sharedLinks.enabled',
    'sharedLinks.sidebarWeb',
    'tags.enabled',
    'tags.sidebarWeb',
    'cast.gCastEnabled',
    'recentlyAdded.sidebarWeb',
  ];

  const store = createOwnPreferencesDraft(keys);
  const draft = $derived(store.draft);
  const castDisabledByAdmin = $derived(draft['cast.adminDisabled']);

  const toolName = (tool: Tool) => $t(`frameleaf_prefs_tools_${tool.id}` as Translations);
  const rows = $derived(
    TOOLS.map((tool): TellRow => ({
      id: tool.id,
      label: toolName(tool),
      help:
        tool.id === 'cast' && castDisabledByAdmin
          ? $t('frameleaf_prefs_tools_cast_admin_off')
          : $t(`frameleaf_prefs_tools_${tool.id}_help` as Translations),
    })),
  );
  const toolOf = (row: TellRow) => TOOLS.find((tool) => tool.id === row.id)!;

  /** A number as one of a few choices, with the saved number as "Custom" when it is none of them. */
  const choices = (values: number[], saved: number | null | undefined, word: Translations, custom: Translations) => [
    ...values.map((value) => ({ value: String(value), label: $t(word, { values: { count: value } }) })),
    ...(typeof saved === 'number' && !values.includes(saved)
      ? [{ value: String(saved), label: $t(custom, { values: { count: saved } }) }]
      : []),
  ];
  const SECONDS = [3, 5, 8];
  const PHOTOS = [1, 3, 5, 10];
</script>

<OwnPreferencesForm {store}>
  <KitPage>
    <Section title={$t('frameleaf_prefs_tools_yours')} description={$t('frameleaf_prefs_tools_yours_description')}>
      <Tell
        heading={$t('frameleaf_prefs_tools_heading')}
        columns={[$t('frameleaf_prefs_tools_column_use'), $t('frameleaf_prefs_tools_column_sidebar')]}
        {rows}
      >
        {#snippet cell(row, column)}
          {@const tool = toolOf(row)}
          {@const key = column === 0 ? tool.use : tool.sidebar}
          {#if key}
            <Switch
              label={$t(column === 0 ? 'frameleaf_prefs_tools_use' : 'frameleaf_prefs_tools_show', {
                values: { tool: row.label },
              })}
              checked={draft[key]}
              held={column === 0
                ? tool.id === 'cast' && castDisabledByAdmin
                : tool.use !== undefined && !draft[tool.use]}
              onChange={(value) => store.set(key, value)}
            />
          {:else}
            {column === 0 ? $t('frameleaf_prefs_tools_always') : $t('frameleaf_prefs_tools_no_sidebar')}
          {/if}
        {/snippet}
      </Tell>
    </Section>

    <Section title={$t('frameleaf_prefs_tools_memories_options')}>
      <Row
        label={$t('frameleaf_prefs_tools_memories_duration')}
        help={$t('frameleaf_prefs_tools_memories_duration_help')}
      >
        <SegmentedControl
          label={$t('frameleaf_prefs_tools_memories_duration')}
          options={choices(
            SECONDS,
            store.baseline['memories.duration'],
            'frameleaf_prefs_tools_seconds',
            'frameleaf_prefs_tools_custom_seconds',
          )}
          value={String(draft['memories.duration'])}
          disabled={!draft['memories.enabled']}
          onChange={(value) => store.set('memories.duration', Number(value))}
        />
      </Row>
    </Section>

    <Section title={$t('frameleaf_prefs_tools_people_options')}>
      <Row label={$t('frameleaf_prefs_tools_people_minimum')} help={$t('frameleaf_prefs_tools_people_minimum_help')}>
        <SegmentedControl
          label={$t('frameleaf_prefs_tools_people_minimum')}
          options={choices(
            PHOTOS,
            store.baseline['people.minimumFaces'],
            'frameleaf_prefs_tools_photos',
            'frameleaf_prefs_tools_custom_photos',
          )}
          value={String(draft['people.minimumFaces'])}
          disabled={!draft['people.enabled']}
          onChange={(value) => store.set('people.minimumFaces', Number(value))}
        />
      </Row>
    </Section>
  </KitPage>
</OwnPreferencesForm>
