<script lang="ts">
  /**
   * Storage & originals › Move or export (FL-365, the approved prototype's
   * `settings-v2/library/move.jsx`): three plain choices in place of a command-line checklist.
   * Moving to a new server or a bigger drive is done in Frameleaf Manager (owner decision 2026-10-10,
   * FL-360), so each move says what will happen and opens it. A server without Frameleaf Manager
   * (`getManagerAccess` has no address) is told its two ways: restore a backup, or the checklist,
   * which stays under Advanced. Nothing on this page moves anything.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Tiles from '$lib/components/frameleaf/settings/kit/Tiles.svelte';
  import MigrationChecklistDialog from '$lib/components/frameleaf/settings/MigrationChecklistDialog.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getManagerAccess } from '@frameleaf/sdk';
  import { mdiExportVariant, mdiShieldCheckOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Way = 'server' | 'drive' | 'copy';
  let way = $state<Way | undefined>();
  let managerUrl = $state<string | null>(null);
  let managerChecked = $state(false);
  let checklistOpen = $state(false);
  let notice = $state('');

  onMount(() => {
    let active = true;
    void getManagerAccess()
      .then((value) => {
        if (active) {
          managerUrl = value.url;
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) {
          managerChecked = true;
        }
      });
    return () => {
      active = false;
    };
  });

  const WAYS: Way[] = ['server', 'drive', 'copy'];
  const tiles = $derived(
    WAYS.map((id) => ({
      id,
      name: $t(`frameleaf_move_way_${id}` as Translations),
      hint: $t(`frameleaf_move_way_${id}_hint` as Translations),
    })),
  );
  const copyRows = $derived<LinkRow[]>([
    {
      icon: mdiExportVariant,
      title: $t('frameleaf_move_export'),
      body: $t('frameleaf_move_export_body'),
      href: commandCenterUrl('backup', 'preservation'),
    },
    {
      icon: mdiShieldCheckOutline,
      title: $t('frameleaf_move_backup'),
      body: $t('frameleaf_move_backup_body'),
      href: commandCenterUrl('backups'),
    },
  ]);
</script>

<KitPage>
  <Section title={$t('frameleaf_move_what_title')} description={$t('frameleaf_move_what_description')}>
    <div class="pad">
      <Tiles label={$t('frameleaf_move_what_title')} value={way} options={tiles} onChange={(id) => (way = id as Way)} />
    </div>
  </Section>

  {#if way === 'server' || way === 'drive'}
    {#if managerUrl}
      <Section
        title={$t(`frameleaf_move_way_${way}` as Translations)}
        description={$t('frameleaf_move_manager_description')}
      >
        <Row label={$t('frameleaf_move_happens')} help={$t(`frameleaf_move_happens_${way}` as Translations)}>
          <a class="fl-control button primary" href={`${managerUrl}/#storage`} target="_blank" rel="noopener noreferrer"
            >{$t('frameleaf_move_open_manager')}</a
          >
        </Row>
      </Section>
    {:else if managerChecked}
      <Section title={$t(`frameleaf_move_way_${way}` as Translations)}>
        <div class="pad">
          <Notice title={$t('frameleaf_move_no_manager')}
            >{$t(`frameleaf_move_no_manager_${way}` as Translations)}</Notice
          >
        </div>
        <Row
          label={$t(`frameleaf_move_restore_${way}` as Translations)}
          help={$t(`frameleaf_move_restore_${way}_help` as Translations)}
        >
          <Button variant="primary" onclick={() => goto(commandCenterUrl('backups', 'restore'))}
            >{$t('frameleaf_move_restore')}</Button
          >
        </Row>
        <Row label={$t('frameleaf_move_or_checklist')} help={$t('frameleaf_move_or_checklist_help')}>
          <Button onclick={() => (checklistOpen = true)}>{$t('frameleaf_move_show_checklist')}</Button>
        </Row>
      </Section>
    {/if}
  {:else if way === 'copy'}
    <Section title={$t('frameleaf_move_way_copy')} description={$t('frameleaf_move_copy_description')}>
      <Links rows={copyRows} stacked />
    </Section>
  {/if}

  <Section title={$t('frameleaf_move_experts')} description={$t('frameleaf_move_experts_description')}>
    <Advanced summary={$t('frameleaf_move_advanced')}>
      <p class="hint">{$t('frameleaf_move_advanced_hint')}</p>
      <div class="pad">
        <Button
          onclick={() => {
            notice = '';
            checklistOpen = true;
          }}>{$t('frameleaf_move_open_checklist')}</Button
        >
      </div>
      {#if notice}<p class="hint" role="status">{notice}</p>{/if}
    </Advanced>
  </Section>
</KitPage>

<MigrationChecklistDialog bind:open={checklistOpen} onDone={() => (notice = $t('frameleaf_move_nothing_moved'))} />

<style>
  .pad {
    padding-bottom: var(--fl-space-5);
  }
  .hint {
    margin: 0 0 var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .button {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-4);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .button.primary {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
