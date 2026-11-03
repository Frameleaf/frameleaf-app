<script lang="ts">
  /**
   * The Clients introduction (owner, October 28; the prototype's `ClientsIntro.jsx` and
   * `clients-intro.css`). Clients is opt-in: until the account starts using it, it lives under Tools
   * and opens this page. "Start using Clients" turns the account's `clients.enabled` preference on,
   * which adds Clients to the top bar and opens the workspace; the caller owns that action.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { Route } from '$lib/route';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiArrowLeft,
    mdiArrowRight,
    mdiCameraIris,
    mdiImageMultipleOutline,
    mdiPackageVariantClosed,
    mdiWeb,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  let {
    onStart,
    starting = false,
  }: {
    /** Start using Clients. */
    onStart: () => void;
    /** The preference is being saved; the button waits for it. */
    starting?: boolean;
  } = $props();

  const points: [string, Translations, Translations][] = [
    [mdiCameraIris, 'frameleaf_clients_intro_shoots', 'frameleaf_clients_intro_shoots_text'],
    [mdiImageMultipleOutline, 'frameleaf_clients_intro_proofing', 'frameleaf_clients_intro_proofing_text'],
    [mdiPackageVariantClosed, 'frameleaf_clients_intro_delivery', 'frameleaf_clients_intro_delivery_text'],
    [mdiWeb, 'frameleaf_clients_intro_website', 'frameleaf_clients_intro_website_text'],
  ];
</script>

<section class="clients-intro" aria-labelledby="clients-intro-title">
  <a class="clients-intro-back" href={Route.photos()}>
    <Icon icon={mdiArrowLeft} size="1rem" aria-hidden={true} />
    {$t('frameleaf_photography_back_to_library')}
  </a>
  <span class="clients-intro-mark" aria-hidden="true">
    <Icon icon={mdiCameraIris} size="2rem" aria-hidden={true} />
  </span>
  <h1 id="clients-intro-title">{$t('frameleaf_photography')}</h1>
  <p class="clients-intro-lead">{$t('frameleaf_clients_intro_lead')}</p>
  <ul>
    {#each points as [icon, title, text] (title)}
      <li>
        <Icon {icon} size="1.25rem" aria-hidden={true} />
        <span>
          <strong>{$t(title)}</strong>
          <small>{$t(text)}</small>
        </span>
      </li>
    {/each}
  </ul>
  <Button variant="primary" disabled={starting} onclick={onStart}>
    <Icon icon={mdiArrowRight} size="1rem" aria-hidden={true} />
    {$t('frameleaf_clients_intro_start')}
  </Button>
  <p class="clients-intro-note">{$t('frameleaf_clients_intro_note')}</p>
</section>

<style>
  /* clients-intro.css, with the app's tokens. */
  .clients-intro {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    min-height: 100%;
    padding: 48px 24px;
    text-align: center;
    color: var(--fl-text);
  }
  .clients-intro-back {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 2.75rem;
    padding: 0 var(--fl-space-2);
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
    text-decoration: none;
  }
  .clients-intro-back:hover {
    color: var(--fl-text);
  }
  .clients-intro-back:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .clients-intro-mark {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-accent-soft);
    color: var(--fl-accent);
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
  }
  .clients-intro-lead {
    max-width: 520px;
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  ul {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    width: min(760px, 100%);
    margin: 8px 0;
    padding: 0;
    list-style: none;
    text-align: start;
  }
  li {
    display: flex;
    gap: 12px;
    padding: 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  li > :global(svg) {
    flex: none;
    color: var(--fl-accent);
  }
  li span {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .clients-intro-note {
    max-width: 480px;
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
