<script lang="ts">
  /**
   * An area's section directory (FL-71), the template's `SectionDirectory` in `CommandCenter.jsx`:
   * one card per section with its title, help and what it applies to. Choosing one opens that
   * section alone; the Command Center shows one section at a time.
   */
  import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { sections, icon, onSelect }: { sections: SettingsHostSection[]; icon: string; onSelect: (key: string) => void } =
    $props();
</script>

<div class="cc-directory">
  <div class="cc-directory-list">
    {#each sections as section (`${section.admin ? 'server' : 'account'}:${section.key}`)}
      <button type="button" onclick={() => onSelect(section.key)}>
        <Icon icon={section.icon || icon} size="1.25rem" aria-hidden />
        <span>
          <strong>{section.title}</strong>
          <span>{section.subtitle}</span>
          <small>{section.admin ? $t('frameleaf_cc_scope_server_settings') : $t('frameleaf_cc_own')}</small>
        </span>
        <Icon icon={mdiChevronRight} size="1.125rem" aria-hidden />
      </button>
    {/each}
  </div>
</div>

<style>
  .cc-directory {
    display: grid;
    gap: 28px;
    margin: 22px 0 32px;
  }
  .cc-directory-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .cc-directory-list button {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px;
    text-align: start;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    font: inherit;
    cursor: pointer;
  }
  .cc-directory-list button:hover {
    background: var(--fl-raised);
    border-color: color-mix(in srgb, var(--fl-muted) 60%, var(--fl-border));
  }
  .cc-directory-list button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .cc-directory-list button > :global(svg:first-child) {
    align-self: flex-start;
    margin-top: 1px;
    color: var(--fl-muted);
  }
  .cc-directory-list button > :global(svg:last-child) {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--fl-muted);
  }
  .cc-directory-list button > span {
    display: grid;
    flex: 1;
    gap: 6px;
    min-width: 0;
  }
  .cc-directory-list strong {
    font-size: 13px;
    font-weight: 550;
  }
  .cc-directory-list button > span > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    line-height: 1.5;
  }
  .cc-directory-list small {
    color: var(--fl-muted);
    font-size: 10px;
  }
  @media (max-width: 700px) {
    .cc-directory-list {
      grid-template-columns: 1fr;
    }
  }
</style>
