<script lang="ts">
  /**
   * The Frameleaf PIN entry control: a row of digit cells backed by a single masked input.
   *
   * Shared by the sign-in PIN prompt (`/auth/pin-prompt`) and the Locked unlock flow, which
   * routes through the same page via `?continue=/locked`. One component keeps their
   * validation and paste behaviour identical: pasting a full code fills every cell in one
   * step because the visible cells are a pure readout of a single `<input>`'s value, not
   * separate fields that must be walked one at a time.
   *
   * The PIN itself never leaves this component's local state on its way to the caller: it is
   * handed to `oncomplete` and otherwise only ever bound through `value`. Nothing here logs
   * or persists it. A caller clears a rejected code by setting the bound `value` back to ''
   * (e.g. on a failed unlock); callers must not log or store the digits either.
   */
  let {
    value = $bindable(''),
    length = 6,
    label,
    error = false,
    disabled = false,
    autofocus = false,
    describedBy,
    oncomplete,
    context = 'auth',
  }: {
    /** Current digits, most-recent-first is not applied: left-to-right entry order. */
    value?: string;
    context?: 'auth' | 'locked';
    /** Number of digits the PIN requires. */
    length?: number;
    /** Translated accessible name for the hidden input, e.g. "Six-digit PIN". */
    label: string;
    /** Marks every cell as invalid (e.g. after a rejected PIN) without changing the value. */
    error?: boolean;
    disabled?: boolean;
    autofocus?: boolean;
    /** Id(s) of the caller's hint/error text for aria-describedby. */
    describedBy?: string;
    /** Fires once, with the completed value, the moment the last digit is entered. */
    oncomplete?: (value: string) => void;
  } = $props();

  let focused = $state(false);
  let shaking = $state(false);
  $effect(() => {
    if (error && context === 'auth') {
      shaking = true;
    }
  });

  const cells = $derived(Array.from({ length }, (_, index) => index));
  const activeIndex = $derived(Math.min(value.length, length - 1));

  // Only a real input/paste event reaches here, so a completed code is reported exactly
  // once per entry -- including a retry that happens to repeat the previous digits.
  const oninput = (event: Event) => {
    const digits = (event.currentTarget as HTMLInputElement).value.replaceAll(/\D/g, '').slice(0, length);
    value = digits;

    if (digits.length === length) {
      oncomplete?.(digits);
    }
  };
</script>

<div
  class="pin-cells"
  class:locked-pin-cells={context === 'locked'}
  class:pin-shake={shaking}
  class:error
  class:focused
  onanimationend={() => (shaking = false)}
>
  {#each cells as index (index)}
    <span
      aria-hidden="true"
      class="pin-cell"
      class:filled={index < value.length}
      class:active={index === activeIndex && focused}
    ></span>
  {/each}
  <!-- svelte-ignore a11y_autofocus (the caller opts in when the PIN is the only field on the dialog) -->
  <input
    class="pin-input"
    type="password"
    inputmode="numeric"
    autocomplete="one-time-code"
    pattern="[0-9]*"
    maxlength={length}
    {disabled}
    {autofocus}
    {value}
    aria-label={label}
    aria-describedby={describedBy}
    aria-invalid={error ? true : undefined}
    {oninput}
    onfocus={() => (focused = true)}
    onblur={() => (focused = false)}
  />
</div>

<style>
  .pin-cells {
    position: relative;
    display: flex;
    gap: 0.625rem;
    justify-content: center;
    padding: 0.25rem;
  }
  .pin-cell {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 3.375rem;
    font-size: 1.375rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    transition: border-color var(--fl-motion-fast) var(--fl-ease);
  }
  .pin-cell.filled::after {
    content: '';
    width: 0.75rem;
    height: 0.75rem;
    background: currentColor;
    border-radius: 50%;
  }
  .pin-cells.focused .pin-cell.active {
    border-color: var(--fl-accent);
    box-shadow: 0 0 0 1px var(--fl-accent);
  }
  .pin-cells.error .pin-cell {
    border-color: var(--fl-danger);
  }
  .locked-pin-cells {
    margin: 16px 0 10px;
    justify-content: flex-start;
  }
  .locked-pin-cells .pin-cell {
    width: 46px;
    height: 56px;
  }
  .pin-shake {
    animation: pin-shake 420ms var(--fl-ease);
  }
  @keyframes pin-shake {
    10%,
    90% {
      transform: translateX(-2px);
    }
    20%,
    80% {
      transform: translateX(4px);
    }
    30%,
    50%,
    70% {
      transform: translateX(-6px);
    }
    40%,
    60% {
      transform: translateX(6px);
    }
  }
  .pin-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    color: transparent;
    caret-color: transparent;
    background: transparent;
    border: 0;
    opacity: 0;
    cursor: default;
  }
</style>
