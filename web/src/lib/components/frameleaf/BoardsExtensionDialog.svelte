<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { Route } from '$lib/route';
  import { Icon } from '@frameleaf/ui';
  import { mdiGoogleChrome, mdiMicrosoftEdge, mdiOpenInNew } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Get the browser extension" from the foot of the Boards rail (prototype `ExtensionDialog`, README
   * point 63, FL-655): three steps — add the extension (Chrome and Edge), sign in with your Frameleaf
   * account (choose this server, Sign in, then Allow), start saving. A key made by hand is only a
   * fallback for a browser that can't sign in: "Use a key instead" opens API keys.
   */
  let { open = $bindable(false) }: { open?: boolean } = $props();

  /** The store listings, searched by name until the listing addresses are fixed. */
  const CHROME_STORE_URL = 'https://chromewebstore.google.com/search/Frameleaf';
  const EDGE_STORE_URL = 'https://microsoftedge.microsoft.com/addons/search/Frameleaf';
  const apiKeysHref = `${Route.userSettings()}?area=privacy&section=api-keys`;
</script>

<Dialog title={$t('frameleaf_boards_extension_title')} closeLabel={$t('close')} bind:open>
  <ol class="steps">
    <li>
      <strong>{$t('frameleaf_boards_extension_step_add')}</strong>
      <span>{$t('frameleaf_boards_extension_step_add_hint')}</span>
      <div class="row">
        <a class="button" href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer">
          <Icon icon={mdiGoogleChrome} size="18" aria-hidden={true} />
          {$t('frameleaf_boards_extension_chrome')}
          <Icon icon={mdiOpenInNew} size="14" aria-hidden={true} />
          <span class="sr-only">{$t('frameleaf_boards_opens_new_tab')}</span>
        </a>
        <a class="button" href={EDGE_STORE_URL} target="_blank" rel="noopener noreferrer">
          <Icon icon={mdiMicrosoftEdge} size="18" aria-hidden={true} />
          {$t('frameleaf_boards_extension_edge')}
          <Icon icon={mdiOpenInNew} size="14" aria-hidden={true} />
          <span class="sr-only">{$t('frameleaf_boards_opens_new_tab')}</span>
        </a>
      </div>
    </li>
    <li>
      <strong>{$t('frameleaf_boards_extension_step_sign_in')}</strong>
      <span>{$t('frameleaf_boards_extension_step_sign_in_hint')}</span>
    </li>
    <li>
      <strong>{$t('frameleaf_boards_extension_step_start')}</strong>
      <span>{$t('frameleaf_boards_extension_step_start_hint')}</span>
      <a class="use-key" href={apiKeysHref} onclick={() => (open = false)}>{$t('frameleaf_boards_extension_use_key')}</a
      >
    </li>
  </ol>
  {#snippet actions()}
    <button type="button" class="button" data-initial-focus onclick={() => (open = false)}>{$t('close')}</button>
  {/snippet}
</Dialog>

<style>
  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-4);
    width: min(30rem, 100%);
    margin: 0;
    padding-inline-start: 1.25rem;
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .steps li {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-inline-start: 0.25rem;
  }
  .steps li::marker {
    color: var(--fl-muted);
    font-weight: 600;
  }
  .steps span {
    color: var(--fl-muted);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 0.375rem;
  }
  .row .button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    text-decoration: none;
  }
  .use-key {
    align-self: flex-start;
    margin-block-start: 0.25rem;
    color: var(--fl-muted);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .use-key:hover {
    color: var(--fl-text);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
