<script lang="ts">
  /**
   * The welcome message people see before they sign in (FL-426), drawn the same way on the sign-in
   * page and in Settings › Server name & welcome's "What people will see": plain text exactly as
   * typed (line breaks kept), or web formatting cleaned by `cleanWelcomeHtml`.
   */
  import { cleanWelcomeHtml } from '$lib/frameleaf/welcome-message';
  import type { LoginPageMessageFormat } from '@frameleaf/sdk';

  // The format by its value, so the sign-in page needs nothing from the SDK at run time.
  let { message, format }: { message: string; format: `${LoginPageMessageFormat}` } = $props();

  const formatted = $derived(format === 'html');
  const html = $derived(formatted ? cleanWelcomeHtml(message) : '');
</script>

{#if formatted}
  <!-- Cleaned by cleanWelcomeHtml: text tags and links only. -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  <div class="welcome-message is-formatted">{@html html}</div>
{:else}
  <div class="welcome-message">{message}</div>
{/if}

<style>
  .welcome-message {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .welcome-message:not(.is-formatted) {
    white-space: pre-line;
  }
  .is-formatted :global(:is(p, ul, ol, blockquote, h2, h3, h4)) {
    margin: 0 0 var(--fl-space-2);
  }
  .is-formatted :global(:is(p, ul, ol, blockquote, h2, h3, h4):last-child) {
    margin-bottom: 0;
  }
  .is-formatted :global(:is(ul, ol)) {
    padding-inline-start: var(--fl-space-5);
  }
  .is-formatted :global(ul) {
    list-style: disc;
  }
  .is-formatted :global(ol) {
    list-style: decimal;
  }
  .is-formatted :global(:is(h2, h3, h4)) {
    color: var(--fl-text);
    font-size: inherit;
    font-weight: 600;
  }
  .is-formatted :global(:is(b, strong)) {
    color: var(--fl-text);
    font-weight: 600;
  }
  .is-formatted :global(a) {
    color: var(--fl-accent);
    text-decoration: underline;
  }
  .is-formatted :global(hr) {
    margin: var(--fl-space-2) 0;
    border: 0;
    border-top: 1px solid var(--fl-border);
  }
</style>
