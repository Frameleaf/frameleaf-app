<script lang="ts">
  /** A large selectable card for plain two-way or three-way choices (FirstRunSetup.jsx `ChoiceCard`). */
  import symbolUrl from '$lib/assets/frameleaf/frameleaf-symbol.svg?url';
  import SetupRecommended from '$lib/components/frameleaf/setup/SetupRecommended.svelte';
  import { Icon } from '@immich/ui';
  import { mdiCheck } from '@mdi/js';
  import type { Snippet } from 'svelte';

  type Props = {
    name: string;
    value: string;
    checked: boolean;
    onchange: (value: string) => void;
    /** An mdi path, or `frameleaf` for the Frameleaf symbol. */
    icon?: string;
    title: string;
    recommended?: boolean;
    disabled?: boolean;
    children?: Snippet;
  };
  const { name, value, checked, onchange, icon, title, recommended, disabled, children }: Props = $props();
</script>

<label class="frs-choice" class:checked class:disabled>
  <input type="radio" {name} {value} {checked} {disabled} onchange={() => onchange(value)} />
  <span class="frs-choice-head">
    {#if icon}
      <span class="frs-choice-icon">
        {#if icon === 'frameleaf'}
          <img src={symbolUrl} alt="" width="22" height="22" />
        {:else}
          <Icon {icon} size="22" aria-hidden={true} />
        {/if}
      </span>
    {/if}
    <strong>{title}</strong>
    {#if recommended}<SetupRecommended />{/if}
    <span class="frs-choice-mark" aria-hidden="true"><Icon icon={mdiCheck} size="14" /></span>
  </span>
  <span class="frs-choice-body">{@render children?.()}</span>
</label>
