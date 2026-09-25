<script lang="ts" module>
  import type { SectionScope } from '$lib/frameleaf/settings-areas';

  /** One row of an area directory: a settings page (or a tool) the row opens. */
  export type DirectoryRow = {
    id: string;
    title: string;
    description: string;
    /** The translated group heading; rows without one sit in an unheaded list. */
    group?: string;
    scope?: SectionScope;
    /** The row's own icon (an mdi path), drawn before its title as the template does for tools. */
    icon?: string;
    onSelect: () => void;
  };
</script>

<script lang="ts">
  /**
   * An area's directory (FL-71, FL-10), the template's `SectionDirectory` (CommandCenter.jsx:2707-2757)
   * with the Sept 24 grouped-list style (command-center.css:1619-1695): one inset grouped list per
   * group, like System Settings. Rows carry no repeated area icon, and a scope tag only when the row
   * applies to someone other than the rest of its area ("Just you" among server settings, and so on).
   * A row with an icon of its own (the utilities, `utilities-data.mjs:15-87`) shows it first, as
   * `SectionDirectory` does (CommandCenter.jsx:2739, command-center.css:1663-1666).
   * A group named like its area does not repeat the name as a heading.
   */
  import { usualScope } from '$lib/frameleaf/settings-areas';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { rows, areaTitle = '' }: { rows: DirectoryRow[]; areaTitle?: string } = $props();

  const usual = $derived(usualScope(rows.map((row) => row.scope).filter((scope) => scope !== undefined)));
  const groups = $derived([...new Set(rows.map((row) => row.group ?? ''))]);
  const scopeTag = (scope: SectionScope) =>
    ({
      server: $t('frameleaf_cc_scope_tag_server'),
      account: $t('frameleaf_cc_scope_tag_account'),
      device: $t('frameleaf_cc_scope_tag_device'),
    })[scope];
</script>

<div class="cc-directory">
  {#each groups as group (group)}
    <section>
      {#if group && group !== areaTitle}
        <h2>{group}</h2>
      {/if}
      <div class="cc-directory-list fl-continuous-corners">
        {#each rows.filter((row) => (row.group ?? '') === group) as row (row.id)}
          <button type="button" onclick={row.onSelect}>
            {#if row.icon}
              <span class="row-icon"><Icon icon={row.icon} size="1.25rem" aria-hidden /></span>
            {/if}
            <span class="copy">
              <strong>{row.title}</strong>
              <span>{row.description}</span>
            </span>
            {#if row.scope && usual && row.scope !== usual}
              <small class="cc-directory-scope">{scopeTag(row.scope)}</small>
            {/if}
            <Icon icon={mdiChevronRight} size="1.125rem" aria-hidden />
          </button>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .cc-directory {
    display: grid;
    gap: 26px;
    max-width: 820px;
    margin: 22px 0 32px;
  }
  h2 {
    margin: 0 0 8px 14px;
    color: var(--fl-muted);
    font-size: 13px;
    font-weight: 600;
  }
  .cc-directory-list {
    display: grid;
    overflow: hidden;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @supports (corner-shape: squircle) {
    .cc-directory-list {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  button {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 11px 14px;
    text-align: start;
    color: var(--fl-text);
    background: none;
    border: 0;
    border-radius: 0;
    font: inherit;
    cursor: pointer;
  }
  button + button {
    box-shadow: inset 0 1px 0 var(--fl-border);
  }
  button:hover {
    background: var(--fl-raised);
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  button > :global(svg) {
    flex-shrink: 0;
    color: var(--fl-muted);
  }
  .row-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--fl-muted);
  }
  .copy {
    flex: 1;
    min-width: 0;
  }
  strong {
    display: block;
    font-size: 14px;
    font-weight: 550;
  }
  .copy > span {
    display: block;
    margin-top: 2px;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .cc-directory-scope {
    flex-shrink: 0;
    padding: 2px 8px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
    font-size: 11px;
  }
  @media (max-width: 700px) {
    button {
      min-height: 44px;
    }
  }
</style>
