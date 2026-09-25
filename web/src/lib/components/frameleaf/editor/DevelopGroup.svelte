<script lang="ts">
  /**
   * One Lightroom-style slider group (Light, Color, Effects, Detail) of the Adjust panel
   * (FL-113). The header toggles the group and shows a dot while any slider differs from its
   * default; the reset control returns only this group to defaults.
   */
  import EditorSlider from '$lib/components/frameleaf/editor/EditorSlider.svelte';
  import {
    formatParam,
    groupIsDefault,
    groupReset,
    paramsInGroup,
    type DevelopGroupId,
    type DevelopValues,
  } from '$lib/frameleaf/develop';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiRestore } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    group,
    label,
    values,
    open = $bindable(true),
    onChange,
  }: {
    group: DevelopGroupId;
    label: string;
    values: DevelopValues;
    open?: boolean;
    onChange: (patch: Partial<DevelopValues>) => void;
  } = $props();

  const bodyId = $props.id();
  const params = paramsInGroup(group);
  const isDefault = $derived(groupIsDefault(values, group));
</script>

<section class="ed-group">
  <div class="ed-group-head">
    <button
      type="button"
      class="ed-group-toggle"
      aria-expanded={open}
      aria-controls={bodyId}
      onclick={() => (open = !open)}
    >
      <!-- One chevron that rotates open on a spring (editor.css `.ed-chevron`, Editor.jsx:373). -->
      <Icon icon={mdiChevronRight} size="18" class="ed-chevron" />
      <span>{label}</span>
      {#if !isDefault}
        <i class="ed-dot" aria-hidden="true"></i>
      {/if}
    </button>
    <button
      type="button"
      class="ed-icon"
      aria-label={$t('frameleaf_editor_reset_group', { values: { group: label } })}
      title={$t('frameleaf_editor_reset_group', { values: { group: label } })}
      disabled={isDefault}
      onclick={() => onChange(groupReset(group))}
    >
      <Icon icon={mdiRestore} size="18" />
    </button>
  </div>
  {#if open}
    <div id={bodyId} class="ed-group-body">
      {#each params as spec (spec.id)}
        <EditorSlider
          id={spec.id}
          label={$t(spec.label)}
          value={values[spec.id]}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          defaultValue={spec.default}
          format={(value) => formatParam(spec, value)}
          onChange={(value) => onChange({ [spec.id]: value })}
        />
      {/each}
    </div>
  {/if}
</section>
