<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { Route } from '$lib/route';
  import { Icon } from '@frameleaf/ui';
  import { mdiGoogleChrome, mdiKeyPlus, mdiMicrosoftEdge, mdiOpenInNew } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Get the browser extension" from the foot of the Boards rail (prototype `ExtensionDialog`, README
   * point 11): three steps — add the extension (Chrome and Edge), make a browser key, paste it.
   * The key is made in API keys settings, where "Browser extension" is one of the key purposes.
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
      <strong>{$t('frameleaf_boards_extension_step_key')}</strong>
      <span>{$t('frameleaf_boards_extension_step_key_hint')}</span>
      <div class="row">
        <a class="button" href={apiKeysHref} onclick={() => (open = false)}>
          <Icon icon={mdiKeyPlus} size="18" aria-hidden={true} />
          {$t('frameleaf_boards_extension_step_key')}
        </a>
      </div>
    </li>
    <li>
      <strong>{$t('frameleaf_boards_extension_step_paste')}</strong>
      <span>{$t('frameleaf_boards_extension_step_paste_hint')}</span>
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
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
