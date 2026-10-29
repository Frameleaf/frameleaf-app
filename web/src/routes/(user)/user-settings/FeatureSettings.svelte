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
   *
   * ACCOUNT-P4: beside the tools, "Your sidebar" says back what the switches make, as they change;
   * the Memories and People options are closed disclosures under their rows while the tool is on.
   */
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Tell, { type TellRow } from '$lib/components/frameleaf/settings/kit/Tell.svelte';
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import MySmartAlbums from '$lib/components/frameleaf/settings/intelligence/MySmartAlbums.svelte';
  import type { AccountPreferenceKey } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountOutline,
    mdiClockOutline,
    mdiDeleteOutline,
    mdiFolderMultipleOutline,
    mdiHeartOutline,
    mdiHistory,
    mdiImageAlbum,
    mdiImageMultipleOutline,
    mdiImageSearchOutline,
    mdiLinkVariant,
    mdiMapOutline,
    mdiTagMultipleOutline,
  } from '@mdi/js';
  import { locale, t, type Translations } from 'svelte-i18n';

  type SwitchKey =
    | 'clients.enabled'
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

  /**
   * A tool, the switch that turns it on (none: always on), its sidebar switch (none: no sidebar
   * item) and, for a sidebar item, the rail's icon for it (`$lib/frameleaf/navigation`).
   */
  type Tool = { id: string; use?: SwitchKey; sidebar?: SwitchKey; icon?: string };
  const TOOLS: Tool[] = [
    { id: 'folders', use: 'folders.enabled', sidebar: 'folders.sidebarWeb', icon: mdiFolderMultipleOutline },
    { id: 'memories', use: 'memories.enabled', sidebar: 'memories.sidebarWeb', icon: mdiHistory },
    { id: 'people', use: 'people.enabled', sidebar: 'people.sidebarWeb', icon: mdiAccountOutline },
    { id: 'shared_links', use: 'sharedLinks.enabled', sidebar: 'sharedLinks.sidebarWeb', icon: mdiLinkVariant },
    { id: 'tags', use: 'tags.enabled', sidebar: 'tags.sidebarWeb', icon: mdiTagMultipleOutline },
    { id: 'ratings', use: 'ratings.enabled' },
    { id: 'cast', use: 'cast.gCastEnabled' },
    // Opt-in: on, Clients joins the top bar beside Library, Boards and Studio.
    { id: 'clients', use: 'clients.enabled' },
    { id: 'recent', sidebar: 'recentlyAdded.sidebarWeb', icon: mdiClockOutline },
  ];

  // ACCOUNT-P4: the items always in the sidebar, around the ones these switches add (the prototype's).
  const FIXED_TOP: { icon: string; label: Translations }[] = [
    { icon: mdiImageMultipleOutline, label: 'photos' },
    { icon: mdiImageSearchOutline, label: 'explore' },
    { icon: mdiMapOutline, label: 'map' },
  ];
  const FIXED_BOTTOM: { icon: string; label: Translations }[] = [
    { icon: mdiHeartOutline, label: 'favorites' },
    { icon: mdiImageAlbum, label: 'albums' },
    { icon: mdiDeleteOutline, label: 'trash' },
  ];

  const keys: AccountPreferenceKey[] = [
    'clients.enabled',
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

  /** The tools the sidebar shows with the switches as they are now: in it, and turned on. */
  const shown = $derived(TOOLS.filter((tool) => tool.sidebar && draft[tool.sidebar] && (!tool.use || draft[tool.use])));
  const listFormat = $derived(new Intl.ListFormat($locale ?? 'en', { style: 'long', type: 'conjunction' }));
  const list = (names: string[]) => listFormat.format(names);

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
    <div class="columns">
      <Section title={$t('frameleaf_prefs_tools_yours')} description={$t('frameleaf_prefs_tools_yours_description')}>
        <Tell
          heading={$t('frameleaf_prefs_tools_heading')}
          columns={[$t('frameleaf_prefs_tools_column_use'), $t('frameleaf_prefs_tools_column_sidebar')]}
          {rows}
        >
          {#snippet detail(row)}
            <!-- ACCOUNT-P4: a tool's options sit under its row, closed, while the tool is on. -->
            {#if row.id === 'memories' && draft['memories.enabled']}
              <details class="options">
                <summary>{$t('frameleaf_prefs_tools_memories_options')}</summary>
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
                    onChange={(value) => store.set('memories.duration', Number(value))}
                  />
                </Row>
              </details>
            {:else if row.id === 'people' && draft['people.enabled']}
              <details class="options">
                <summary>{$t('frameleaf_prefs_tools_people_options')}</summary>
                <Row
                  label={$t('frameleaf_prefs_tools_people_minimum')}
                  help={$t('frameleaf_prefs_tools_people_minimum_help')}
                >
                  <SegmentedControl
                    label={$t('frameleaf_prefs_tools_people_minimum')}
                    options={choices(
                      PHOTOS,
                      store.baseline['people.minimumFaces'],
                      'frameleaf_prefs_tools_photos',
                      'frameleaf_prefs_tools_custom_photos',
                    )}
                    value={String(draft['people.minimumFaces'])}
                    onChange={(value) => store.set('people.minimumFaces', Number(value))}
                  />
                </Row>
              </details>
            {/if}
          {/snippet}
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

      <!-- ACCOUNT-P4: the sidebar said back as the switches change (prototype `bk2-preview`). -->
      <aside class="preview fl-continuous-corners" aria-label={$t('frameleaf_prefs_tools_sidebar')}>
        <h2>{$t('frameleaf_prefs_tools_sidebar')}</h2>
        <ul>
          {#each FIXED_TOP as item (item.label)}
            <li class="is-fixed"><Icon icon={item.icon} size="18" aria-hidden={true} />{$t(item.label)}</li>
          {/each}
          {#each shown as tool (tool.id)}
            <li>
              {#if tool.icon}<Icon icon={tool.icon} size="18" aria-hidden={true} />{/if}{toolName(tool)}
            </li>
          {/each}
          {#each FIXED_BOTTOM as item (item.label)}
            <li class="is-fixed"><Icon icon={item.icon} size="18" aria-hidden={true} />{$t(item.label)}</li>
          {/each}
        </ul>
        <p>
          {shown.length > 0
            ? $t('frameleaf_prefs_tools_sidebar_added', {
                values: { tools: list(shown.map((tool) => toolName(tool))) },
              })
            : $t('frameleaf_prefs_tools_sidebar_none')}
        </p>
      </aside>
    </div>
    <!-- FL-522: each person can hide a smart album from their own library. -->
    <MySmartAlbums />
  </KitPage>
</OwnPreferencesForm>

<style>
  /* backup-v2.css `.bk2-columns`: the tools, and the sidebar they make beside them. */
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(240px, 0.65fr);
    gap: var(--fl-space-6);
    align-items: start;
  }
  @container kit (max-width: 860px) {
    .columns {
      grid-template-columns: 1fr;
    }
  }
  /* backup-v2.css `.bk2-preview` with server.css `.srv-sidebar`. */
  .preview {
    display: grid;
    gap: var(--fl-space-4);
    padding: var(--fl-space-6);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .preview h2 {
    margin: 0;
    color: var(--fl-muted);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.8px;
    text-transform: uppercase;
  }
  .preview ul {
    display: grid;
    gap: var(--fl-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .preview li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    min-height: 36px;
    padding: 0 var(--fl-space-3);
    border-radius: var(--fl-radius-control);
    font-size: 13px;
    font-weight: 600;
    background: var(--fl-raised);
  }
  .preview li :global(svg) {
    color: var(--fl-accent);
  }
  .preview li.is-fixed {
    color: var(--fl-muted);
    font-weight: 400;
    background: none;
  }
  .preview li.is-fixed :global(svg) {
    color: inherit;
  }
  .preview p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  /* A tool's options under its row: closed, as the prototype's `<details>`. */
  .options {
    margin-top: var(--fl-space-3);
  }
  .options summary {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
    cursor: pointer;
  }
</style>
