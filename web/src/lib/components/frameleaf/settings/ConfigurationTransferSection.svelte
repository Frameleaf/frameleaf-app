<script lang="ts">
  /**
   * Server & updates › Copy settings (FL-368, after the approved prototype
   * `settings-v2/server/server-updates.jsx`; the actions are FL-71's and never carry a credential,
   * FL-67). Two actions with different names for different things: "Save to a file" and "Load from
   * a file", with "Copy as text" as a small link. What the file holds is a short list; the file
   * itself is behind "Show the file", credentials already emptied.
   *
   * A loaded file is kept as unsaved changes, like anything typed on a settings page: the page lists
   * each setting that would change in the words on its own page, and nothing is saved until the
   * settings bar's review is confirmed.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Points from '$lib/components/frameleaf/settings/kit/Points.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { describeChange } from '$lib/frameleaf/setting-words';
  import { redactConfigForExport } from '$lib/frameleaf/system-config-draft';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getSystemConfigActions } from '$lib/services/system-config.service';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRight, mdiDownload, mdiUpload } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const settingsDraft = getSystemConfigDraft();
  const actions = $derived(
    settingsDraft
      ? getSystemConfigActions($t, featureFlagsManager.value, settingsDraft.baseline, {
          onImport: (text) => settingsDraft.importFile(text),
        })
      : undefined,
  );
  const exported = $derived(
    settingsDraft ? JSON.stringify(redactConfigForExport(settingsDraft.baseline), null, 2) : '',
  );
  const waiting = $derived(
    (settingsDraft?.changes ?? []).map((change) => ({ path: change.path, ...describeChange($t, 'server', change) })),
  );
</script>

{#if actions}
  <KitPage>
    {#if waiting.length > 0}
      <Notice title={$t('frameleaf_srvadv_copy_waiting', { values: { count: waiting.length } })}>
        {$t('frameleaf_srvadv_copy_waiting_body')}
      </Notice>
    {/if}

    <Section title={$t('frameleaf_srvadv_copy_save')} description={$t('frameleaf_srvadv_copy_save_description')}>
      {#snippet action()}
        <Button onclick={() => actions.Download.onAction(actions.Download)}>
          <Icon icon={mdiDownload} size="1rem" aria-hidden={true} />
          {$t('frameleaf_srvadv_copy_save_action')}
        </Button>
      {/snippet}
      <Points
        label={$t('frameleaf_srvadv_copy_included')}
        rows={[
          { text: $t('frameleaf_srvadv_copy_in_settings') },
          { text: $t('frameleaf_srvadv_copy_out_media'), not: true },
          { text: $t('frameleaf_srvadv_copy_out_secrets'), not: true },
        ]}
      />
      <p class="aside">
        <button type="button" class="link" onclick={() => actions.CopyToClipboard.onAction(actions.CopyToClipboard)}>
          {$t('frameleaf_srvadv_copy_text')}
        </button>
      </p>
      <Advanced summary={$t('frameleaf_srvadv_copy_show')}>
        <pre>{exported}</pre>
      </Advanced>
    </Section>

    {#if actions.Upload.$if?.() ?? true}
      <Section title={$t('frameleaf_srvadv_copy_load')} description={$t('frameleaf_srvadv_copy_load_description')}>
        {#snippet action()}
          <Button onclick={() => actions.Upload.onAction(actions.Upload)}>
            <Icon icon={mdiUpload} size="1rem" aria-hidden={true} />
            {$t('frameleaf_srvadv_copy_load_action')}
          </Button>
        {/snippet}
        {#if waiting.length > 0}
          <ul class="changes" aria-label={$t('frameleaf_srvadv_copy_changes')}>
            {#each waiting as change (change.path)}
              <li>
                <strong>{change.label}</strong>
                <span>
                  {change.before}
                  <Icon icon={mdiArrowRight} size="14" aria-label={$t('frameleaf_words_history_to')} />
                  <b>{change.after}</b>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </Section>
    {/if}
  </KitPage>
{/if}

<style>
  .aside {
    margin: 0;
    padding-bottom: var(--fl-space-4);
    font-size: var(--fl-font-callout);
  }
  .link {
    padding: 0;
    color: var(--fl-accent);
    font: inherit;
    font-weight: 600;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .link:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
    border-radius: var(--fl-radius-sm);
  }
  pre {
    max-height: 420px;
    margin: 0;
    padding: var(--fl-space-4);
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fl-font-small);
    line-height: 1.6;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .changes {
    margin: 0;
    padding: 0 0 var(--fl-space-2);
    list-style: none;
  }
  .changes li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-3) 0;
    font-size: var(--fl-font-callout);
    border-top: 1px solid var(--fl-border);
  }
  .changes strong {
    font-weight: 600;
  }
  .changes span {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
    max-width: 420px;
    color: var(--fl-muted);
    overflow-wrap: anywhere;
  }
  .changes b {
    color: var(--fl-text);
    font-weight: 600;
  }
  @container kit (max-width: 620px) {
    .changes li {
      grid-template-columns: 1fr;
      gap: var(--fl-space-2);
    }
    .changes span {
      justify-content: flex-start;
    }
  }
</style>
