<script lang="ts" module>
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
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
    /** FL-519: the tool's state in a few words ("12 groups to look at"), shown before the chevron. */
    status?: { text: string; tone: KitTone };
    /** FL-539: a word under the state, such as "Checked last night". */
    note?: string;
    onSelect: () => void;
  };
</script>

<script lang="ts">
  /**
   * An area's directory (FL-71, FL-10), the template's `SectionDirectory` (CommandCenter.jsx:2707-2757)
   * with the Sept 24 grouped-list style (command-center.css:1619-1695): one inset grouped list per
   * group, like System Settings. Rows carry no repeated area icon, and a scope tag only when the row
   * applies to someone other than the rest of its area ("Just you" among server settings, and so on).
   * Every row shows its own icon first (FL-168: each settings section's, and each tool's,
   * `utilities-data.mjs:15-87`), as `SectionDirectory` does (CommandCenter.jsx:2784, command-center.css:1663-1666).
   * A group named like its area does not repeat the name as a heading.
   */
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { usualScope } from '$lib/frameleaf/settings-areas';
  import { Icon } from '@frameleaf/ui';
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
            {#if row.status}
              <span class="cc-directory-status"
                ><Pill tone={row.status.tone}>{row.status.text}</Pill>{#if row.note}<small>{row.note}</small>{/if}</span
              >
            {/if}
            {#if row.scope && usual && row.scope !== usual}
              <small class="cc-directory-scope">{scopeTag(row.scope)}</small>
            {/if}
            <!-- The prototype's "Open ›" on each row (settings-v2 Item); the whole row is the button. -->
            <span class="open" aria-hidden="true"
              >{$t('open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></span
            >
          </button>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  /*
   * The approved settings kit (settings-v2 `Section` + `ItemList`): each group is a card with its
   * heading inside, and every row lines up the same columns: icon tile, name, state, "Open ›".
   */
  .cc-directory {
    display: grid;
    gap: var(--fl-space-6);
    max-width: 1120px;
    margin: var(--fl-space-6) 0 var(--fl-space-8);
  }
  section {
    min-width: 0;
    padding: 0 var(--fl-space-6) var(--fl-space-2);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @supports (corner-shape: squircle) {
    section {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  h2 {
    margin: 0;
    padding: var(--fl-space-5) 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: var(--fl-tracking-headline);
  }
  .cc-directory-list {
    display: grid;
  }
  section:not(:has(h2)) .cc-directory-list {
    padding-top: var(--fl-space-2);
  }
  button {
    display: grid;
    grid-template-columns: 44px minmax(0, 1.2fr) minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--fl-space-4);
    min-height: 56px;
    padding: var(--fl-space-4) 0;
    text-align: start;
    color: var(--fl-text);
    background: none;
    border: 0;
    border-top: 1px solid var(--fl-border);
    border-radius: 0;
    font: inherit;
    cursor: pointer;
  }
  section:not(:has(h2)) button:first-child {
    border-top: 0;
  }
  button:hover .open {
    border-color: var(--fl-accent);
  }
  button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
    border-radius: var(--fl-radius-control);
  }
  .row-icon {
    display: grid;
    grid-column: 1;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .copy {
    grid-column: 2;
    min-width: 0;
  }
  strong {
    display: block;
    font-size: 14px;
    font-weight: 600;
  }
  .copy > span {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .cc-directory-status {
    display: grid;
    grid-column: 3;
    justify-items: start;
    gap: var(--fl-space-1);
    min-width: 0;
  }
  .cc-directory-status small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .cc-directory-scope {
    grid-column: 4;
    padding: 2px 8px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
    font-size: 11px;
  }
  .open {
    display: inline-flex;
    grid-column: 5;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    transition: border-color var(--fl-motion-fast) var(--fl-ease);
  }
  @media (max-width: 860px) {
    section {
      padding-inline: var(--fl-space-4);
    }
    button {
      grid-template-columns: 44px minmax(0, 1fr) auto;
      row-gap: var(--fl-space-2);
    }
    .cc-directory-status,
    .cc-directory-scope {
      grid-row: 2;
      grid-column: 2 / -1;
    }
    .open {
      grid-row: 1;
      grid-column: 3;
    }
  }
</style>
