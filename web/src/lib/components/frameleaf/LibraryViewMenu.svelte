<script lang="ts">
  /**
   * The Library View menu (FL-1398), ported from the prototype's `LibraryViewMenu.jsx` and
   * `library-view-menu.css`: everything about how the library looks, in one menu.
   *
   * A chevron row shows its current choice and opens a second page of the menu, whose first row goes
   * back. On phones the menu is a sheet above the tab bar; the sticky toolbar blurs what is behind it,
   * which would trap a fixed sheet inside the toolbar, so the sheet is moved to `sheetRoot` (the
   * library's own root, which carries the theme).
   *
   * The results toolbar owns the View button, the open state, Escape and the click outside. A host
   * that only has an information panel (search results, Boards) gets that one switch.
   */
  import { THUMBNAIL_SIZE_DEFAULT } from '$lib/frameleaf/library-grid';
  import { libraryGridPreferences, type LibraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import {
    captionPatch,
    captionsFor,
    LIBRARY_GROUPS,
    nearestViewSize,
    VIEW_SIZES,
    type LibraryGroupBy,
    type LibraryViewMenuOptions,
  } from '$lib/frameleaf/library-view';
  import { libraryView, type LibraryViewStore } from '$lib/frameleaf/library-view.svelte';
  import { pop } from '$lib/frameleaf/motion';
  import { getPartners, PartnerDirection } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiChevronLeft, mdiChevronRight } from '@mdi/js';
  import { tick } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    options?: LibraryViewMenuOptions;
    inspectorOpen?: boolean;
    onToggleInspector?: () => void;
    /** Phones: where the sheet is drawn. Null draws the menu under its button. */
    sheetRoot?: HTMLElement | null;
    element?: HTMLElement;
    onkeydown?: (event: KeyboardEvent) => void;
    onfocusout?: (event: FocusEvent) => void;
    view?: LibraryViewStore;
    preferences?: LibraryGridPreferences;
  };

  let {
    options,
    inspectorOpen,
    onToggleInspector,
    sheetRoot = null,
    element = $bindable(),
    onkeydown,
    onfocusout,
    view = libraryView,
    preferences = libraryGridPreferences,
  }: Props = $props();

  type Page = 'group' | 'stacks' | 'also';
  const PAGE_TITLES: Record<Page, Translations> = {
    group: 'frameleaf_library_view_group_by',
    stacks: 'frameleaf_library_view_stacks',
    also: 'frameleaf_library_view_also_show',
  };
  const GROUP_LABELS: Record<LibraryGroupBy, Translations> = { none: 'none', day: 'day', month: 'month', year: 'year' };
  const SIZE_LABELS: Record<(typeof VIEW_SIZES)[number]['id'], Translations> = {
    small: 'frameleaf_library_view_size_small',
    medium: 'frameleaf_library_view_size_medium',
    large: 'frameleaf_library_view_size_large',
  };

  let page = $state<Page | null>(null);
  const choices = $derived(view.value);
  const captions = $derived(options ? captionsFor(choices, options.layout) : { time: false, names: false });
  const size = $derived(nearestViewSize(preferences.thumbnailSize));
  const alsoShown = $derived(
    [choices.partnerPhotos && $t('frameleaf_library_partner_photos'), choices.archived && $t('archived')]
      .filter(Boolean)
      .join(', '),
  );

  /** "Photos Jamie shares with you" names the one partner who shares; otherwise it says partners. */
  let partnerName = $state<string>();
  const findPartner = async () => {
    try {
      const partners = await getPartners({ direction: PartnerDirection.SharedWith });
      partnerName = partners.length === 1 ? partners[0].name : '';
    } catch {
      partnerName = '';
    }
  };
  $effect(() => {
    // Asked as the menu opens, so the row does not change its wording while it is being read.
    if (options?.libraryRoot && partnerName === undefined) {
      void findPartner();
    }
  });

  /** A page change keeps the keyboard where the person is: on the back row, then on the row left. */
  const show = async (next: Page | null) => {
    const from = page;
    page = next;
    await tick();
    element?.querySelector<HTMLElement>(next ? '.fl-view-back' : `[data-page="${from}"]`)?.focus();
  };

  const reset = () => {
    view.reset();
    preferences.thumbnailSize = THUMBNAIL_SIZE_DEFAULT;
  };

  /** Phones: the sheet is drawn at the library root, outside the toolbar that would trap it. */
  const sheet = (node: HTMLElement, root: HTMLElement | null) => {
    root?.append(node);
  };
</script>

{#snippet switchRow(label: string, checked: boolean, onChange: (checked: boolean) => void, ariaLabel?: string)}
  <label class="fl-view-row">
    <span>{label}</span>
    <input
      type="checkbox"
      role="switch"
      aria-label={ariaLabel}
      {checked}
      onchange={(event) => onChange(event.currentTarget.checked)}
    />
  </label>
{/snippet}

{#snippet chevronRow(id: Page, value: string)}
  <button type="button" class="fl-view-row fl-view-more" data-page={id} onclick={() => void show(id)}>
    <span>{$t(PAGE_TITLES[id])}</span>
    <span class="fl-view-value">
      {value}
      <Icon icon={mdiChevronRight} size="18" aria-hidden />
    </span>
  </button>
{/snippet}

{#snippet choice(label: string, selected: boolean, onSelect: () => void)}
  <button
    type="button"
    role="menuitemradio"
    aria-checked={selected}
    class="fl-view-row fl-view-choice"
    onclick={onSelect}
  >
    <span>{label}</span>
    {#if selected}<Icon icon={mdiCheck} size="18" aria-hidden />{/if}
  </button>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="fl-view-menu fl-pop fl-origin-top-end"
  class:is-full={!!options}
  class:is-sheet={!!sheetRoot}
  role="group"
  aria-label={$t('frameleaf_library_view_menu')}
  data-testid="frameleaf-view-menu"
  bind:this={element}
  use:sheet={sheetRoot}
  {onkeydown}
  {onfocusout}
  out:pop
>
  {#if page && options}
    <div class="fl-view-sub">
      <button type="button" class="fl-view-back" onclick={() => void show(null)}>
        <Icon icon={mdiChevronLeft} size="18" aria-hidden />
        <span class="fl-sr">{$t('back')}:</span>
        {$t(PAGE_TITLES[page])}
      </button>
      {#if page === 'group'}
        <div class="fl-view-section" role="menu" aria-label={$t(PAGE_TITLES.group)}>
          {#each LIBRARY_GROUPS as value (value)}
            {@render choice($t(GROUP_LABELS[value]), choices.groupBy === value, () => view.set({ groupBy: value }))}
          {/each}
          <p>{$t('frameleaf_library_view_group_hint')}</p>
        </div>
      {:else if page === 'stacks'}
        <div class="fl-view-section" role="menu" aria-label={$t(PAGE_TITLES.stacks)}>
          {@render choice($t('frameleaf_library_view_stacks_together'), choices.stacksTogether, () =>
            view.set({ stacksTogether: true }),
          )}
          {@render choice($t('frameleaf_library_view_stacks_apart'), !choices.stacksTogether, () =>
            view.set({ stacksTogether: false }),
          )}
          <p>{$t('frameleaf_library_view_stacks_hint')}</p>
        </div>
      {:else}
        <section class="fl-view-section" aria-label={$t(PAGE_TITLES.also)}>
          {@render switchRow(
            partnerName
              ? $t('frameleaf_library_view_also_partner', { values: { name: partnerName } })
              : $t('frameleaf_library_view_also_partners'),
            choices.partnerPhotos,
            (partnerPhotos) => view.set({ partnerPhotos }),
          )}
          {@render switchRow($t('frameleaf_library_view_also_archived'), choices.archived, (archived) =>
            view.set({ archived }),
          )}
          <p>{$t('frameleaf_library_view_also_locked')}</p>
        </section>
      {/if}
    </div>
  {:else}
    {#if (inspectorOpen !== undefined && onToggleInspector) || options?.scrubber}
      <section class="fl-view-section" aria-label={$t('frameleaf_library_view_panels')}>
        {#if options}<h3>{$t('frameleaf_library_view_panels')}</h3>{/if}
        {#if inspectorOpen !== undefined && onToggleInspector}
          {@render switchRow(
            $t('frameleaf_library_information_panel'),
            inspectorOpen,
            onToggleInspector,
            $t(inspectorOpen ? 'frameleaf_work_inspector_hide' : 'frameleaf_work_inspector_show'),
          )}
        {/if}
        {#if options?.scrubber}
          {@render switchRow($t('frameleaf_library_view_scrubber'), choices.scrubber, (scrubber) =>
            view.set({ scrubber }),
          )}
        {/if}
      </section>
    {/if}
    {#if options}
      <section class="fl-view-section" aria-label={$t('photos')}>
        <h3>{$t('photos')}</h3>
        <div class="fl-view-row">
          <span id="fl-view-size">{$t('size')}</span>
          <div class="fl-view-segmented" role="group" aria-labelledby="fl-view-size">
            {#each VIEW_SIZES as entry (entry.id)}
              <button
                type="button"
                aria-pressed={size === entry.id}
                onclick={() => (preferences.thumbnailSize = entry.size)}
              >
                {$t(SIZE_LABELS[entry.id])}
              </button>
            {/each}
          </div>
        </div>
        {#if options.grid}
          {@render switchRow($t('frameleaf_library_view_crop'), choices.crop, (crop) => view.set({ crop }))}
          {@render chevronRow('group', $t(GROUP_LABELS[choices.groupBy]))}
        {/if}
        {#if options.stacks}
          {@render chevronRow(
            'stacks',
            $t(
              choices.stacksTogether
                ? 'frameleaf_library_view_stacks_together_short'
                : 'frameleaf_library_view_stacks_apart_short',
            ),
          )}
        {/if}
      </section>
      <section class="fl-view-section" aria-label={$t('frameleaf_library_view_show_on_photos')}>
        <h3>{$t('frameleaf_library_view_show_on_photos')}</h3>
        {@render switchRow($t('frameleaf_library_view_time'), captions.time, (time) =>
          view.set(captionPatch(options.layout, { time })),
        )}
        {@render switchRow($t('frameleaf_library_view_file_name'), captions.names, (names) =>
          view.set(captionPatch(options.layout, { names })),
        )}
        {@render switchRow($t('frameleaf_library_view_rating'), choices.ratings, (ratings) => view.set({ ratings }))}
        {@render switchRow($t('frameleaf_library_view_favorite'), choices.favorites, (favorites) =>
          view.set({ favorites }),
        )}
        {@render switchRow($t('frameleaf_library_view_badges'), choices.badges, (badges) => view.set({ badges }))}
      </section>
      {#if options.libraryRoot}
        <section class="fl-view-section" aria-label={$t('library')}>
          <h3>{$t('library')}</h3>
          {@render chevronRow('also', alsoShown || $t('frameleaf_library_view_also_nothing'))}
        </section>
      {/if}
      <footer>
        <button type="button" class="fl-view-reset" onclick={reset}>{$t('frameleaf_library_view_reset')}</button>
      </footer>
    {/if}
  {/if}
</div>

<style>
  /* FL-707 item 10 (review-1030-library.css `.view-options-menu`), the one-switch menu. */
  .fl-view-menu {
    position: absolute;
    z-index: 6;
    inset-inline-end: 0;
    top: calc(100% + 6px);
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    min-width: 260px;
    padding: 8px 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card, 12px);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
    text-align: start;
  }
  .fl-view-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    min-height: 36px;
    color: var(--fl-text);
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }
  div.fl-view-row {
    cursor: default;
  }
  .fl-view-row input {
    width: 16px;
    height: 16px;
    /* The row is the click area; the box itself is not held to the control floor. */
    min-height: 0;
    accent-color: var(--fl-accent);
  }
  /* FL-1398 (library-view-menu.css `.is-full`): sections with a small heading, rows 34px tall. */
  .fl-view-menu.is-full {
    width: 300px;
    gap: 0;
    padding: 6px 0 0;
    /*
     * However far down the page its button is (`--fl-view-top`), the menu ends above the floating
     * status bar, which is drawn over the photos' scroller and so over this menu, and scrolls inside.
     */
    max-height: min(calc(100vh - 290px), calc(100vh - var(--fl-view-top, 0px) - 88px));
    overflow-y: auto;
  }
  .fl-view-section {
    display: grid;
  }
  .is-full .fl-view-section {
    padding: 8px 16px;
  }
  .is-full .fl-view-section + .fl-view-section {
    border-top: 1px solid var(--fl-border);
  }
  h3 {
    margin: 0 0 4px;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro, 11px);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .is-full .fl-view-row {
    min-height: 34px;
  }
  .fl-view-segmented {
    display: flex;
    padding: 2px;
    border-radius: var(--fl-radius-control);
    background: var(--fl-canvas);
    box-shadow: inset 0 0 0 1px var(--fl-border);
  }
  .fl-view-segmented button {
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--fl-radius-xs);
    background: transparent;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
    cursor: pointer;
  }
  .fl-view-segmented button:hover {
    color: var(--fl-text);
  }
  .fl-view-segmented button[aria-pressed='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
    box-shadow: 0 0 0 1px var(--fl-border);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    padding: 6px 16px 8px;
    border-top: 1px solid var(--fl-border);
  }
  .fl-view-reset {
    min-height: 29px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font-size: var(--fl-font-small, 12px);
    cursor: pointer;
  }
  .fl-view-reset:hover {
    text-decoration: underline;
  }
  /* Chevron rows open a second page of the menu; its first row goes back. */
  button.fl-view-row {
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
  }
  .fl-view-value {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
  }
  .fl-view-more:hover .fl-view-value,
  .fl-view-choice:hover {
    color: var(--fl-text);
  }
  .fl-view-choice :global(svg) {
    color: var(--fl-accent);
  }
  button.fl-view-row:focus-visible,
  .fl-view-back:focus-visible,
  .fl-view-reset:focus-visible,
  .fl-view-segmented button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
    border-radius: var(--fl-radius-xs);
  }
  .fl-view-back {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    border: 0;
    border-bottom: 1px solid var(--fl-border);
    background: none;
    color: var(--fl-text);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .fl-view-sub p {
    margin: 8px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
    line-height: 1.45;
    white-space: normal;
  }
  .fl-view-sub .fl-view-row span:first-child {
    white-space: normal;
  }
  .fl-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Phones: a sheet above the tab bar, inside the 12px gutters, and it scrolls. */
  .fl-view-menu.is-sheet {
    position: fixed;
    top: auto;
    inset-inline: 12px;
    bottom: calc(var(--fl-view-sheet-bottom, 88px) + env(safe-area-inset-bottom));
    width: auto;
    max-height: calc(100dvh - 160px - env(safe-area-inset-bottom));
    z-index: 9;
    transform-origin: bottom center;
  }
  .is-sheet .fl-view-row {
    min-height: 44px;
  }
  .is-sheet .fl-view-segmented button {
    min-height: 36px;
    padding: 0 12px;
  }
</style>
