<script lang="ts">
  /**
   * A labelled switch row in a Frameleaf Cloud card (FrameleafCloud.jsx:278-307): the label, one or
   * two sentences of help, why it is unavailable when disabled, and a fixed policy such as "Always
   * on". Uses the Frameleaf Toggle, so the state is written beside the track.
   */
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    label: string;
    help: string;
    checked: boolean;
    disabled?: boolean;
    reason?: string;
    policy?: string;
    onChange?: (checked: boolean) => void;
  };

  let { label, help, checked, disabled = false, reason, policy, onChange }: Props = $props();
  const helpId = $props.id();
</script>

<div class="fc-field">
  <div>
    <span class="fc-field-label">{label}</span>
    <p id={helpId}>
      {help}
      {#if disabled && reason}
        <span class="fc-reason">{reason}</span>
      {/if}
    </p>
    {#if policy}
      <small class="fc-policy">{policy}</small>
    {/if}
  </div>
  <Toggle
    {label}
    {checked}
    disabled={disabled || !!policy}
    describedBy={helpId}
    onLabel={$t('frameleaf_cloud_toggle_on')}
    offLabel={$t('frameleaf_cloud_toggle_off')}
    {onChange}
  />
</div>
