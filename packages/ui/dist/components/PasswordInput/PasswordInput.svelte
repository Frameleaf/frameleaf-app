<script lang="ts">
  import IconButton from '../IconButton/IconButton.svelte';
  import Input from '../Input/Input.svelte';
  import { t } from '../../services/translation.svelte.js';
  import type { PasswordInputProps } from '../../types.js';
  import { mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';

  let {
    value = $bindable<string>(),
    translations,
    isVisible = $bindable<boolean>(false),
    color = 'secondary',
    size,
    ...props
  }: PasswordInputProps = $props();

  let labelValue = $derived(isVisible ? t('hide_password', translations) : t('show_password', translations));
</script>

<Input bind:value {size} type={isVisible ? 'text' : 'password'} {color} {...props}>
  {#snippet trailingIcon(disabled)}
    {#if value?.length > 0}
      <IconButton
        variant="ghost"
        shape="round"
        color="secondary"
        {size}
        class="me-1"
        icon={isVisible ? mdiEyeOffOutline : mdiEyeOutline}
        onclick={() => (isVisible = !isVisible)}
        {disabled}
        title={labelValue}
        aria-label={labelValue}
      />
    {/if}
  {/snippet}
</Input>
