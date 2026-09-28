<script lang="ts">
  /**
   * Acknowledgements (FL-86; owner decisions FL-146, 2026-09-25): every third-party engine, model,
   * voice, font and asset Frameleaf uses that needs credit, with its author, licence and link, and
   * the licence texts themselves, loaded from the files that ship with the product
   * (`licenses/texts`, `studio/notices`) rather than retyped. `licenses/acknowledgements.json` is the
   * single source; `scripts/frameleaf-acknowledgements.mjs` checks it covers everything Studio and
   * the photo library can load.
   *
   * Composed from the prototype's help notices pattern (`SystemPanels.jsx:226-315`, `system.css`
   * `.help-notices`): grouped rows on the raised surface, disclosure for the long parts.
   */
  import acknowledgements from '$licenses/acknowledgements.json';
  import { t, type Translations } from 'svelte-i18n';

  type Component = (typeof acknowledgements.components)[number] & { voices?: string[]; version?: string };

  /** Every shipped licence text, fetched only when someone opens it. */
  const texts = import.meta.glob(['$licenses/texts/*.txt', '$studioNotices/*.txt'], {
    query: '?raw',
    import: 'default',
  }) as Record<string, () => Promise<string>>;

  /** `licenses/texts/mit.txt` → the glob key that holds it. */
  const loaderFor = (file: string) => {
    const name = file.split('/').pop();
    const folder = file.startsWith('studio/notices/') ? 'studio/notices/' : 'licenses/texts/';
    return Object.entries(texts).find(([key]) => key.endsWith(`${folder}${name}`))?.[1];
  };

  let loaded = $state<Record<string, string>>({});
  const load = async (file: string) => {
    if (loaded[file] !== undefined) {
      return;
    }
    const loader = loaderFor(file);
    const text = loader ? await loader() : '';
    loaded = { ...loaded, [file]: text };
  };

  const groupTitles: Record<string, Translations> = {
    'studio-editor': 'frameleaf_ack_group_studio_editor',
    'studio-models': 'frameleaf_ack_group_studio_models',
    'studio-assets': 'frameleaf_ack_group_studio_assets',
    'library-models': 'frameleaf_ack_group_library_models',
  };

  const shippedLabels: Record<string, Translations> = {
    bundled: 'frameleaf_ack_shipped_bundled',
    downloaded: 'frameleaf_ack_shipped_downloaded',
    user: 'frameleaf_ack_shipped_user',
    'administrator-installed': 'frameleaf_ack_shipped_administrator',
  };

  const groups = Object.keys(groupTitles).map((group) => ({
    group,
    components: (acknowledgements.components as Component[]).filter((component) => component.group === group),
  }));

  // Freecut's licence must be shown in full (owner requirement), so it is read as soon as the list is.
  $effect(() => {
    void load('studio/notices/freecut.txt');
  });
</script>

{#snippet licence(file: string)}
  <details
    class="ack-text"
    ontoggle={(event) => {
      if ((event.currentTarget as HTMLDetailsElement).open) {
        void load(file);
      }
    }}
  >
    <summary>{$t('frameleaf_ack_licence_text', { values: { file } })}</summary>
    {#if loaded[file] === undefined}
      <p class="ack-muted">{$t('loading')}</p>
    {:else}
      <pre>{loaded[file]}</pre>
    {/if}
  </details>
{/snippet}

<div class="ack" data-testid="acknowledgements">
  {#each groups as { group, components } (group)}
    <h4>{$t(groupTitles[group])}</h4>
    <ul>
      {#each components as component (component.id)}
        <li>
          <div class="ack-row">
            {#if component.link}
              <a href={component.link} target="_blank" rel="noreferrer">{component.name}</a>
            {:else}
              <strong>{component.name}</strong>
            {/if}
            <span class="ack-muted">
              {component.author}
              {#if component.version}
                · {component.version.slice(0, 7)}
              {/if}
            </span>
            <span class="ack-licence">
              {component.licence}
              {#if component.status === 'to-confirm'}
                · {$t('frameleaf_ack_to_confirm')}
              {/if}
              · {$t(shippedLabels[component.shipped])}
            </span>
          </div>
          {#if component.notice}
            <p class="ack-notice">{component.notice}</p>
          {/if}
          {#if component.voices?.length}
            <p class="ack-muted">{$t('frameleaf_ack_voices', { values: { voices: component.voices.join(', ') } })}</p>
          {/if}
          {#if component.id === 'freecut'}
            <pre data-testid="freecut-licence">{loaded['studio/notices/freecut.txt'] ?? ''}</pre>
          {/if}
          {#each component.noticeFiles as file (file)}
            {@render licence(file)}
          {/each}
        </li>
      {/each}
    </ul>
  {/each}

  <h4>{$t('frameleaf_ack_group_fonts')}</h4>
  <details class="ack-text">
    <summary>
      {$t('frameleaf_ack_font_families', { values: { count: acknowledgements.fonts.families.length } })}
    </summary>
    <p class="ack-muted">{$t('frameleaf_ack_fonts_note')}</p>
    <table>
      <tbody>
        {#each acknowledgements.fonts.families as family (family.name)}
          <tr>
            <td><a href={family.link} target="_blank" rel="noreferrer">{family.name}</a></td>
            <td>{family.designer}</td>
            <td><a href={family.licenceFile} target="_blank" rel="noreferrer">{family.licence}</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </details>
  {#each acknowledgements.fonts.noticeFiles as file (file)}
    {@render licence(file)}
  {/each}
</div>

<style>
  /* design/frameleaf/template/src/system.css `.help-notices` rows. */
  .ack {
    padding: 4px 12px 12px;
    font-size: var(--fl-font-small);
  }
  h4 {
    margin: 12px 0 6px;
    color: var(--fl-muted);
    font-weight: 600;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  li {
    padding-top: 8px;
    border-top: 1px solid var(--fl-border);
  }
  .ack-row {
    display: grid;
    gap: 1px;
  }
  .ack-row a {
    color: inherit;
    font-weight: 600;
  }
  .ack-muted,
  .ack-licence {
    color: var(--fl-muted);
  }
  .ack-notice {
    margin: 4px 0 0;
  }
  p {
    margin: 4px 0 0;
  }
  .ack-text summary {
    cursor: pointer;
    color: var(--fl-muted);
    margin-top: 4px;
  }
  pre {
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    margin: 6px 0 0;
    padding: 8px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-canvas);
    font-size: 11px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  td {
    padding: 4px 0;
    border-top: 1px solid var(--fl-border);
    vertical-align: top;
  }
  td a {
    color: inherit;
  }
</style>
