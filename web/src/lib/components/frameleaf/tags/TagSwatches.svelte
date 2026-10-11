<script lang="ts">
  import { tagColorLabel } from '$lib/components/frameleaf/tags/tag-messages';
  import { TAG_COLORS, type TagColorId } from '$lib/frameleaf/tag-tree';
  import { t } from 'svelte-i18n';

  /**
   * The eight tag colours as one radio group. Arrow keys, Home and End move between the colours and
   * Space or Enter (a click) chooses, so a colour that is applied straight away is never applied by
   * merely passing over it.
   */
  let {
    value,
    initialFocus = false,
    onChange,
  }: {
    value: TagColorId | null;
    /** In a dialog with nothing else to fill in, the chosen colour takes focus when it opens. */
    initialFocus?: boolean;
    onChange: (color: TagColorId) => void;
  } = $props();

  let group = $state<HTMLFieldSetElement>();

  // One tab stop: the chosen colour, or the first when the tag's colour is not one of the eight.
  const tabStop = $derived(value ?? TAG_COLORS[0].id);

  const onKeydown = (event: KeyboardEvent) => {
    const buttons = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) {
      return;
    }
    const last = buttons.length - 1;
    const next = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowDown: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      ArrowUp: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) {
      return;
    }
    // The library grid under a tag page listens for the arrow keys too.
    event.preventDefault();
    buttons[next].focus();
  };
</script>

<fieldset class="swatches" role="radiogroup" bind:this={group} onkeydown={onKeydown}>
  <legend>{$t('frameleaf_tags_color')}</legend>
  {#each TAG_COLORS as option (option.id)}
    <button
      type="button"
      role="radio"
      class="swatch"
      class:on={value === option.id}
      aria-checked={value === option.id}
      aria-label={tagColorLabel($t, option.id)}
      title={tagColorLabel($t, option.id)}
      tabindex={tabStop === option.id ? 0 : -1}
      data-initial-focus={initialFocus && tabStop === option.id ? '' : undefined}
      style:--tag-color={option.hex}
      onclick={() => onChange(option.id)}
    ></button>
  {/each}
</fieldset>

<style>
  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    display: block;
    margin-bottom: var(--fl-space-2);
    padding: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .swatch {
    width: 28px;
    height: 28px;
    min-width: 0;
    min-height: 0;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 50%;
    background: var(--tag-color);
    box-shadow: 0 0 0 1px var(--fl-border);
  }
  .swatch.on {
    border-color: var(--fl-panel);
    box-shadow: 0 0 0 2px var(--fl-accent);
  }
  /* Larger dots for a finger; with the gap around it each is a 44px target. */
  @media (pointer: coarse) {
    .swatch {
      width: 36px;
      height: 36px;
    }
  }
</style>
