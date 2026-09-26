<script lang="ts">
  import {
    commandGroups,
    groupCommands,
    loadRecentCommands,
    navigationCommands,
    recentCommands,
    rememberCommand,
    saveRecentCommands,
    searchCommands,
    shortcutKeys,
    stripCommandPrefix,
    type CommandGroupResult,
    type CommandItem,
  } from '$lib/frameleaf/command-palette';
  import { prefersReducedMotion } from '$lib/frameleaf/motion';
  import '$lib/frameleaf/tokens.css';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The Frameleaf command palette (FL-49), ported from `design/frameleaf/template/src/CommandPalette.jsx`.
   *
   * A top-anchored modal combobox over the live index in `command-index.ts`: pages, settings
   * areas and actions, plus people, albums and places from their APIs. Ranking, grouping and
   * the recents list are the pure functions in `command-palette.ts`; this component owns only
   * the dialog, the roving active option and the keyboard contract.
   *
   * Accessibility follows the prototype: one `combobox` input owning a `listbox`, the active
   * option named by `aria-activedescendant` (options are never focused, so typing continues to
   * reach the input), Escape closes, and the result count is announced politely.
   *
   * September 24, 2026 (second pass): the palette wears the search palette's glass
   * (`apple-style.css:649-710`): a frosted panel with continuous corners, a spring entrance that is a
   * crossfade under Reduce Motion (checked here as well as in CSS), and a solid panel under Increase
   * Contrast or Reduce Transparency.
   */

  let {
    index = [],
    initialQuery = '',
    onRun,
    onClose,
  }: {
    index?: CommandItem[];
    /** Text typed before the palette opened; a leading ">" is stripped. */
    initialQuery?: string;
    onRun?: (command: CommandItem) => void;
    onClose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  let listElement = $state<HTMLElement>();
  let query = $state(stripCommandPrefix(initialQuery));
  // The roving active option, reset to the first whenever the query changes; keys move it.
  let active = $derived.by(() => {
    void query;
    return 0;
  });
  // The page is client-rendered only, so the stored recents are read as the palette opens.
  let recent = $state<string[]>(loadRecentCommands(localStorage));

  const listId = $props.id();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || '');
  const reducedMotion = prefersReducedMotion();

  const searching = $derived(query.trim().length > 0);

  const results = $derived.by((): CommandItem[] => {
    if (searching) {
      return searchCommands(index, query, 30);
    }
    const resolved = recentCommands(index, recent);
    // A recent command whose destination is gone has already been dropped by `recentCommands`,
    // so an empty list here means there is genuinely nothing to resume.
    return resolved.length > 0 ? resolved : navigationCommands(index).slice(0, 10);
  });

  const groups = $derived.by((): CommandGroupResult[] => {
    if (searching) {
      return groupCommands(results);
    }
    const hasRecent = recentCommands(index, recent).length > 0;
    return [
      {
        id: 'pages',
        labelKey: hasRecent ? 'frameleaf_search_recent' : 'frameleaf_search_suggested',
        commands: results,
      },
    ];
  });

  const flat = $derived(groups.flatMap((group) => group.commands));
  const activeIndex = $derived(flat.length === 0 ? -1 : Math.min(active, flat.length - 1));
  const current = $derived(activeIndex >= 0 ? flat[activeIndex] : undefined);

  $effect(() => {
    if (!dialog || dialog.open) {
      return;
    }
    const previous = document.activeElement;
    dialog.showModal();
    input?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  });

  $effect(() => {
    void activeIndex;
    listElement?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });

  const run = (command: CommandItem | undefined) => {
    if (!command) {
      return;
    }
    const next = rememberCommand(recent, command.id);
    recent = next;
    saveRecentCommands(localStorage, next);
    onRun?.(command);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (flat.length > 0) {
        active = (activeIndex + 1) % flat.length;
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (flat.length > 0) {
        active = (activeIndex - 1 + flat.length) % flat.length;
      }
    } else if (event.key === 'Home' && flat.length > 0) {
      event.preventDefault();
      active = 0;
    } else if (event.key === 'End' && flat.length > 0) {
      event.preventDefault();
      active = flat.length - 1;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(current);
    }
  };
</script>

<dialog
  bind:this={dialog}
  class="command-palette frameleaf fl-continuous-corners"
  class:reduced-motion={reducedMotion}
  data-theme={appTheme}
  aria-label={$t('frameleaf_search_command_palette')}
  oncancel={(event) => {
    event.preventDefault();
    onClose();
  }}
>
  <div class="input-row">
    <Icon icon={mdiChevronRight} size="1.25em" aria-hidden={true} />
    <input
      bind:this={input}
      role="combobox"
      aria-expanded="true"
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
      aria-label={$t('frameleaf_search_command_placeholder')}
      placeholder={$t('frameleaf_search_command_placeholder')}
      value={query}
      autocomplete="off"
      spellcheck="false"
      oninput={(event) => (query = event.currentTarget.value.replace(/^\s*>\s*/, ''))}
      onkeydown={onKeyDown}
    />
    <kbd aria-hidden="true">Esc</kbd>
  </div>

  <div class="list" role="listbox" id={listId} bind:this={listElement} aria-label={$t('frameleaf_search_commands')}>
    {#if flat.length === 0}
      <p class="empty">
        <strong>{$t('frameleaf_search_no_commands')}</strong>
        <span>{$t('frameleaf_search_no_commands_hint')}</span>
      </p>
    {/if}
    {#each groups as group (group.labelKey + group.id)}
      <div role="group" aria-label={$t(group.labelKey)}>
        <p class="group-title">{$t(group.labelKey)}</p>
        {#each group.commands as command (command.id)}
          {@const position = flat.indexOf(command)}
          <button
            type="button"
            id="{listId}-{command.id}"
            role="option"
            aria-selected={position === activeIndex}
            class="item"
            tabindex="-1"
            onmousemove={() => {
              if (position >= 0 && position !== activeIndex) {
                active = position;
              }
            }}
            onclick={() => run(command)}
          >
            {#if command.icon}
              <Icon icon={command.icon} size="1.125em" aria-hidden={true} />
            {/if}
            <span class="text">
              <strong>{command.title}</strong>
              {#if command.subtitle}<small>{command.subtitle}</small>{/if}
            </span>
            {#if command.shortcut}
              <span class="keys" aria-hidden="true">
                {#each shortcutKeys(command.shortcut, isApple) as key, keyIndex (key + keyIndex)}
                  <kbd>{key}</kbd>
                {/each}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  <div class="foot">
    <span aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> {$t('frameleaf_search_navigate')}</span>
    <span aria-hidden="true"><kbd>↩</kbd> {$t('frameleaf_search_run')}</span>
    <span aria-live="polite">
      {searching
        ? $t('frameleaf_search_match_count', { values: { count: flat.length } })
        : $t('frameleaf_search_group_count', { values: { count: commandGroups.length } })}
    </span>
  </div>
</dialog>

<style>
  /* The glass treatment the search palette uses (apple-style.css:649-710). */
  .command-palette {
    width: min(40rem, calc(100vw - 2rem));
    max-height: min(36rem, calc(100dvh - 6rem));
    margin-block-start: 12vh;
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: var(--fl-text);
    background: color-mix(in srgb, var(--fl-panel) 74%, transparent);
    backdrop-filter: blur(40px) saturate(180%);
    border: 1px solid color-mix(in srgb, var(--fl-text) 14%, transparent);
    border-radius: 20px;
    box-shadow:
      0 30px 120px #000a,
      inset 0 1px 0 #ffffff14;
    animation: fl-command-palette-in 420ms var(--fl-spring) both;
  }
  @supports (corner-shape: squircle) {
    .command-palette {
      border-radius: 36px;
    }
  }
  @keyframes fl-command-palette-in {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes fl-command-palette-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .command-palette.reduced-motion {
    animation: fl-command-palette-fade 150ms ease both;
  }
  @media (prefers-reduced-motion: reduce) {
    .command-palette {
      animation: fl-command-palette-fade 150ms ease both;
    }
  }
  .command-palette::backdrop {
    background: #0005;
    backdrop-filter: blur(10px);
  }
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .command-palette {
      background: var(--fl-panel);
      backdrop-filter: none;
    }
    .command-palette::backdrop {
      background: rgb(0 0 0 / 67%);
      backdrop-filter: none;
    }
  }
  .input-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 14px 18px 12px;
    color: var(--fl-muted);
    border-bottom: 1px solid color-mix(in srgb, var(--fl-text) 14%, transparent);
  }
  .input-row input {
    flex: 1;
    min-width: 0;
    font-size: 21px;
    letter-spacing: -0.01em;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    outline: none;
  }
  .list {
    min-height: 0;
    overflow-y: auto;
    padding: 0.375rem 0;
  }
  .group-title {
    padding: 0.625rem 1rem 0.25rem;
    font-size: 12px;
    font-weight: 600;
    color: var(--fl-muted);
  }
  .item {
    display: flex;
    width: calc(100% - 12px);
    margin: 0 6px;
    align-items: center;
    gap: 0.625rem;
    min-height: 44px;
    padding: 0.375rem 0.625rem;
    text-align: start;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    border-radius: 8px;
  }
  .item:hover {
    background: color-mix(in srgb, var(--fl-text) 8%, transparent);
  }
  .item[aria-selected='true'] {
    background: color-mix(in srgb, var(--fl-accent) 22%, transparent);
  }
  .text {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .text strong {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .text small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .keys {
    margin-inline-start: auto;
    display: inline-flex;
    gap: 0.1875rem;
  }
  kbd {
    padding: 0.0625rem 0.3125rem;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    background: color-mix(in srgb, var(--fl-text) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--fl-text) 14%, transparent);
    border-radius: 5px;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1.5rem 0.75rem;
    text-align: center;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 0.875rem;
    padding: 0.625rem 1.125rem;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    border-top: 1px solid color-mix(in srgb, var(--fl-text) 14%, transparent);
  }
  .foot span:last-child {
    margin-inline-start: auto;
  }
</style>
