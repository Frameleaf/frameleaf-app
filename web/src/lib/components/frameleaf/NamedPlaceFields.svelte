<script lang="ts">
  /**
   * FL-1019: a place's name and how far it reaches, with the privacy promise (prototype `PlaceFields`).
   * Used by the panel on the map and by the dialogs away from it.
   */
  import { formatRadius, PLACE_NAME_MAX, RADIUS_STEPS, radiusAt, radiusStep } from '$lib/frameleaf/named-places';
  import { locale } from '$lib/stores/preferences.store';
  import { Icon } from '@frameleaf/ui';
  import { mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    name: string;
    radius: number;
    /** How many items the circle holds, when that is known. */
    inside?: number;
    error?: string;
    initialFocus?: boolean;
  }

  let { name = $bindable(), radius = $bindable(), inside, error, initialFocus = false }: Props = $props();

  const id = $props.id();
  const words = $derived(formatRadius(radius, $locale));
</script>

<div class="np-fields">
  <div class="np-field">
    <label for="{id}-name">{$t('frameleaf_named_places_name')}</label>
    <input
      id="{id}-name"
      type="text"
      bind:value={name}
      maxlength={PLACE_NAME_MAX}
      placeholder={$t('frameleaf_named_places_name_placeholder')}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      data-initial-focus={initialFocus ? '' : undefined}
    />
    {#if error}<p id="{id}-error" class="np-error" role="alert">{error}</p>{/if}
  </div>
  <div class="np-field">
    <div class="np-field-head">
      <label for="{id}-radius">{$t('frameleaf_named_places_reach')}</label>
      <output for="{id}-radius">{words}</output>
    </div>
    <input
      id="{id}-radius"
      type="range"
      min="0"
      max={RADIUS_STEPS}
      step="1"
      value={radiusStep(radius)}
      aria-valuetext={words}
      oninput={(event) => (radius = radiusAt(Number(event.currentTarget.value)))}
    />
    <div class="np-range-ends" aria-hidden="true">
      <span>{formatRadius(25, $locale)}</span>
      <span>{formatRadius(5000, $locale)}</span>
    </div>
  </div>
  {#if inside !== undefined}
    <p class="np-count">{$t('frameleaf_named_places_inside', { values: { count: inside } })}</p>
  {/if}
  <p class="np-private">
    <Icon icon={mdiLockOutline} size="16" aria-hidden={true} />
    {$t('frameleaf_named_places_only_you')}
  </p>
</div>

<style>
  .np-fields,
  .np-field {
    display: grid;
    gap: var(--fl-space-4);
  }
  .np-field {
    gap: var(--fl-space-2);
  }
  label,
  output {
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  output {
    font-variant-numeric: tabular-nums;
  }
  .np-field-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  input[type='text'] {
    width: 100%;
    min-height: 40px;
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-canvas);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-callout);
  }
  input[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  input[type='range'] {
    width: 100%;
    height: 24px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  input:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 1px;
  }
  .np-range-ends {
    display: flex;
    justify-content: space-between;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .np-count {
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .np-error {
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .np-private {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.4;
  }
</style>
