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
    /** A row the server's policy fixes (the template's locked field, `CommandCenter.jsx:1632-1636`). */
    policy?: string;
    children?: Snippet;
  }

  let {
    title,
    subtitle = '',
    checked = $bindable(false),
    disabled = false,
    isEdited = false,
    onToggle = () => {},
    policy,
    children,
  }: Props = $props();

  const id = $props.id();
  const subtitleId = $derived(subtitle ? `${id}-subtitle` : undefined);
</script>

<!-- Sept 24 compact row: the switch sits right-aligned beside its label (CommandCenter.jsx:1639-1655). -->
<div class="field" class:edited={isEdited}>
  <div class="copy">
    <div class="label-line">
      <span class="title" id="{id}-title">{title}</span>
      {#if isEdited}
        <span class="unsaved">{$t('unsaved_change')}</span>
      {/if}
    </div>
    {#if subtitle}
      <p id={subtitleId}>{subtitle}</p>
    {/if}
    {@render children?.()}
    {#if policy}
      <small class="locked">{policy}</small>
    {/if}
  </div>
  <div class="control">
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
</div>

<style>
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    padding: 14px 0;
    border-top: 1px solid var(--fl-border);
  }
  .field:first-child {
    border-top: 0;
  }
  .field.edited {
    margin-inline-start: -12px;
    padding-inline-start: 12px;
    box-shadow: inset 3px 0 var(--fl-warning);
  }
  /* command-center.css `.cc-locked` */
  .locked {
    display: block;
    margin-top: 8px;
    color: var(--fl-muted);
    font-size: 10px;
  }
  .copy {
    flex: 1;
    min-width: 0;
  }
  .label-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .unsaved {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--fl-warning);
    font-size: 11px;
    font-weight: 600;
  }
  .unsaved::before {
    content: '';
    width: 5px;
    height: 5px;
    background: currentColor;
    border-radius: 50%;
  }
  .title {
    color: var(--fl-text);
    font-size: 14px;
    font-weight: 500;
  }
  p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .control {
    flex-shrink: 0;
  }
</style>
