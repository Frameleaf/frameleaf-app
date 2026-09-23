<script lang="ts">
  /**
   * A labelled on/off preference row for the Frameleaf settings pages (FL-71). Same props as
   * the legacy SettingSwitch so the existing system-config forms keep their bindings; the
   * control itself is the Frameleaf Toggle, which announces its state in words.
   */
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    title: string;
    subtitle?: string;
    checked?: boolean;
    disabled?: boolean;
    isEdited?: boolean;
    onToggle?: (isChecked: boolean) => void;
    children?: Snippet;
  }

  let {
    title,
    subtitle = '',
    checked = $bindable(false),
    disabled = false,
    isEdited = false,
    onToggle = () => {},
    children,
  }: Props = $props();

  const id = $props.id();
  const subtitleId = $derived(subtitle ? `${id}-subtitle` : undefined);
</script>

<div class="row" class:edited={isEdited}>
  <div class="copy">
    <div class="title-line">
      <span class="title" id="{id}-title">{title}</span>
      {#if isEdited}
        <span class="unsaved">{$t('unsaved_change')}</span>
      {/if}
    </div>
    {#if subtitle}
      <p id={subtitleId}>{subtitle}</p>
    {/if}
    {@render children?.()}
  </div>
  <Toggle
    label={title}
    bind:checked
    {disabled}
    onLabel={$t('enabled')}
    offLabel={$t('disabled')}
    describedBy={subtitleId}
    onChange={onToggle}
  />
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.625rem 0;
  }
  .copy {
    min-width: 0;
  }
  .title-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .title {
    font-weight: 550;
    color: var(--fl-text);
  }
  .unsaved {
    display: inline-flex;
    align-items: center;
    padding: 0 0.5rem;
    min-height: 1.25rem;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-warning);
    color: var(--fl-warning-text);
    font-size: var(--fl-font-micro);
    font-weight: 600;
  }
  p {
    margin: 0.25rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
