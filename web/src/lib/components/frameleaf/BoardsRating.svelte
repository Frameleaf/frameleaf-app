<script lang="ts">
  /**
   * Boards' rating control (approved prototype `Stars`, README point 25): a thumbs-down "Rejected"
   * before five stars. Rejected is the stored rating -1, the value saved links already use, so files
   * and links share one scale. Choosing the current value again clears the rating (null).
   *
   * Every option is a real toggle button (`aria-pressed`) in a labelled group, so each is reachable
   * with Tab and operated with Space or Enter; the state is carried by the filled icon and the
   * pressed state, never by colour alone.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiStar, mdiStarOutline, mdiThumbDown, mdiThumbDownOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    value,
    label,
    disabled = false,
    onChange,
  }: {
    /** 1–5 stars, -1 rejected, null unrated. */
    value: number | null;
    /** The group's accessible name; defaults to "Rating". */
    label?: string;
    disabled?: boolean;
    onChange: (next: number | null) => void;
  } = $props();

  const choose = (next: number) => onChange(value === next ? null : next);
</script>

<div class="fl-boards-rating" role="group" aria-label={label ?? $t('rating')}>
  <button
    type="button"
    class="reject"
    aria-label={$t('frameleaf_library_rating_rejected')}
    title={$t('frameleaf_boards_rating_reject_hint')}
    aria-pressed={value === -1}
    {disabled}
    onclick={() => choose(-1)}
  >
    <Icon icon={value === -1 ? mdiThumbDown : mdiThumbDownOutline} size="18" aria-hidden />
  </button>
  <span class="divider" aria-hidden="true"></span>
  {#each [1, 2, 3, 4, 5] as star (star)}
    <button
      type="button"
      aria-label={$t('rating_count', { values: { count: star } })}
      aria-pressed={value === star}
      class:on={(value ?? 0) >= star}
      {disabled}
      onclick={() => choose(star)}
    >
      <Icon icon={(value ?? 0) >= star ? mdiStar : mdiStarOutline} size="18" aria-hidden />
    </button>
  {/each}
</div>

<style>
  .fl-boards-rating {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  button {
    display: grid;
    place-items: center;
    min-width: 32px;
    min-height: 32px;
    border-radius: var(--fl-radius-sm);
    color: var(--fl-muted);
  }
  button:hover:not(:disabled) {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  button.on,
  button[aria-pressed='true'] {
    color: var(--fl-text);
  }
  .reject[aria-pressed='true'] {
    color: var(--fl-danger);
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .divider {
    width: 1px;
    height: 18px;
    margin-inline: var(--fl-space-2);
    background: var(--fl-border);
  }
</style>
