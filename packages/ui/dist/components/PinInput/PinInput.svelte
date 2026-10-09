<script lang="ts">
  import { getFieldContext } from '../../common/context.svelte.js';
  import Label from '../Label/Label.svelte';
  import { styleVariants } from '../../styles.js';
  import type { PinInputProps } from '../../types.js';
  import { cleanClass } from '../../utilities/internal.js';
  import { PinInput, REGEXP_ONLY_DIGITS } from 'bits-ui';
  import { tv } from 'tailwind-variants';

  let {
    shape = 'semi-round',
    size: initialSize,
    value = $bindable<string>(''),
    length = 6,
    password,
    onComplete,
    class: className,
    ...props
  }: PinInputProps = $props();

  const context = getFieldContext();

  const { label, disabled, ...labelProps } = $derived(context());
  const size = $derived(initialSize ?? labelProps.size ?? 'large');
  // The root receives explicit props after field defaults; mirror the same disabled precedence.
  const inputDisabled = $derived(props.disabled ?? disabled);

  const inputStyles = tv({
    base: 'group-data-[disabled]:text-dark data-active:border-primary dark:data-active:border-primary flex items-center justify-center border-2 bg-gray-100 font-mono transition-all duration-75 group-data-[disabled]:bg-gray-300 data-active:border-3 dark:bg-gray-800 dark:group-not-data-[disabled]:border-gray-700 dark:group-data-[disabled]:bg-gray-900 dark:group-data-[disabled]:text-gray-200',
    variants: {
      shape: styleVariants.shape,
      size: {
        tiny: 'h-9 w-7',
        small: 'h-10 w-8',
        medium: 'h-11 w-9',
        large: 'h-12 w-10',
        giant: 'h-14 w-12',
      },
      textSize: styleVariants.textSize,
      roundedSize: {
        tiny: 'rounded-lg',
        small: 'rounded-lg',
        medium: 'rounded-xl',
        large: 'rounded-xl',
        giant: 'rounded-2xl',
      },
    },
  });

  const caretStyles = tv({
    base: 'caret bg-dark h-1/2',
    variants: {
      size: {
        tiny: 'w-px',
        small: 'w-px',
        medium: 'w-[1.5px]',
        large: 'w-[1.5px]',
        giant: 'w-0.5',
      },
    },
  });

  const id = $props.id();
  const inputId = `input-${id}`;
  const labelId = `label-${id}`;
</script>

<div class={cleanClass('group flex flex-col gap-1', className)} data-disabled={inputDisabled ? true : undefined}>
  {#if label}
    <Label id={labelId} for={inputId} {label} {...labelProps} {size} />
  {/if}

  <PinInput.Root
    {inputId}
    aria-labelledby={label && labelId}
    {disabled}
    aria-disabled={disabled}
    class="flex w-fit items-center gap-2 [direction:ltr]"
    maxlength={length}
    pattern={REGEXP_ONLY_DIGITS}
    type={password ? 'password' : 'text'}
    {onComplete}
    bind:value
    {...props}
  >
    {#snippet children({ cells })}
      {#each cells as cell, i (i)}
        <PinInput.Cell
          {cell}
          class={inputStyles({
            shape,
            size,
            textSize: size,
            roundedSize: shape === 'semi-round' ? size : undefined,
          })}
        >
          {#if cell.char !== null}
            <div>
              {password ? '●' : cell.char}
            </div>
          {/if}
          {#if cell.hasFakeCaret}
            <div class="absolute flex h-full items-center justify-center">
              <div class={caretStyles({ size })}></div>
            </div>
          {/if}
        </PinInput.Cell>
      {/each}
    {/snippet}
  </PinInput.Root>
</div>

<style>
  .caret {
    animation: blink 1.5s step-end infinite;
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }
</style>
