<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    isHttpError,
    photographyPublicContract,
    photographySignContract,
    PhotographyContractSignatureType,
    type PhotographyPublicContractDto,
  } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { token }: { token: string } = $props();

  const historyLabels = {
    created: 'frameleaf_clients_contract_event_created',
    sent: 'frameleaf_clients_contract_event_sent',
    email_verified: 'frameleaf_clients_contract_event_email_verified',
    viewed: 'frameleaf_clients_contract_event_viewed',
    consented: 'frameleaf_clients_contract_event_consented',
    signed: 'frameleaf_clients_contract_event_signed',
    finalized: 'frameleaf_clients_contract_event_finalized',
    voided: 'frameleaf_clients_contract_event_voided',
  } as const;
  const WIDTH = 600;
  const HEIGHT = 140;

  let phase = $state<'loading' | 'ready' | 'unavailable' | 'error' | 'signing' | 'sign-error'>('loading');
  let contract = $state<PhotographyPublicContractDto>();
  let name = $state('');
  let method = $state<PhotographyContractSignatureType>(PhotographyContractSignatureType.Typed);
  let consent = $state(false);
  let drawn = $state(false);
  let canvas = $state<HTMLCanvasElement>();
  let drawing = false;

  async function load() {
    phase = 'loading';
    try {
      contract = await photographyPublicContract({ token });
      phase = 'ready';
    } catch (error) {
      phase = isHttpError(error) && error.status === 404 ? 'unavailable' : 'error';
    }
  }
  onMount(() => void load());

  function point(event: PointerEvent): [number, number] {
    const bounds = canvas!.getBoundingClientRect();
    return [
      ((event.clientX - bounds.left) * WIDTH) / bounds.width,
      ((event.clientY - bounds.top) * HEIGHT) / bounds.height,
    ];
  }
  function start(event: PointerEvent) {
    const context = canvas?.getContext('2d');
    if (!context) {
      return;
    }
    canvas!.setPointerCapture(event.pointerId);
    drawing = true;
    context.strokeStyle = '#1d1d1f';
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(...point(event));
  }
  function move(event: PointerEvent) {
    const context = canvas?.getContext('2d');
    if (!drawing || !context) {
      return;
    }
    context.lineTo(...point(event));
    context.stroke();
    drawn = true;
  }
  function clear() {
    canvas?.getContext('2d')?.clearRect(0, 0, WIDTH, HEIGHT);
    drawn = false;
  }

  async function sign() {
    if (!contract) {
      return;
    }
    phase = 'signing';
    try {
      contract = await photographySignContract({
        token,
        photographyContractSignDto: {
          name: name.trim(),
          signatureType: method,
          consent: true,
          documentSha256: contract.documentSha256,
          ...(method === PhotographyContractSignatureType.Drawn && { signaturePng: canvas!.toDataURL('image/png') }),
        },
      });
      phase = 'ready';
    } catch (error) {
      phase = isHttpError(error) && error.status === 404 ? 'unavailable' : 'sign-error';
    }
  }
  const when = (value: string) => new Date(value).toLocaleString($locale, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head><title>{contract?.name ?? $t('frameleaf_clients_contract_title')}</title></svelte:head>

<main class="sign" style:--studio={contract?.studio.color}>
  <div class="inner">
    {#if contract}
      <header>
        <span aria-hidden="true">{contract.studio.name.slice(0, 1)}</span>
        {contract.studio.name}
      </header>
    {/if}
    <section class="card" aria-busy={phase === 'loading' || phase === 'signing'}>
      {#if phase === 'loading' || phase === 'signing'}
        <p role="status" class="status">
          {phase === 'signing' ? $t('frameleaf_clients_contract_saving') : $t('frameleaf_clients_contract_opening')}
        </p>
      {:else if phase === 'unavailable'}
        <h1>{$t('frameleaf_clients_contract_unavailable')}</h1>
        <p>{$t('frameleaf_clients_contract_unavailable_body')}</p>
      {:else if phase === 'error' || !contract}
        <h1>{$t('frameleaf_clients_contract_open_error')}</h1>
        <Button onclick={load}>{$t('frameleaf_clients_contract_try_again')}</Button>
      {:else if contract.signed}
        <h1>{$t('frameleaf_clients_contract_signed')}</h1>
        <p>{$t('frameleaf_clients_contract_signed_body')}</p>
        <dl>
          <div>
            <dt>{$t('frameleaf_clients_contract_signed_by')}</dt>
            <dd>{contract.signerName}</dd>
          </div>
          <div>
            <dt>{$t('status')}</dt>
            <dd>{$t('frameleaf_clients_contract_status_signed')}</dd>
          </div>
        </dl>
        <details>
          <summary>{$t('frameleaf_clients_contract_history')}</summary>
          <ol>
            {#each contract.history as event, index (index)}
              <li><time datetime={event.at}>{when(event.at)}</time> · {$t(historyLabels[event.type])}</li>
            {/each}
          </ol>
        </details>
        <a class="download" href="/api/photography/sign/{token}/pdf" download
          >{$t('frameleaf_clients_contract_download_signed')}</a
        >
      {:else}
        <h1>{contract.name}</h1>
        <p class="body">{contract.body}</p>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void sign();
          }}
        >
          <label
            >{$t('frameleaf_clients_contract_full_name')}<input
              required
              maxlength="200"
              autocomplete="name"
              bind:value={name}
            /></label
          >
          <fieldset>
            <legend>{$t('frameleaf_clients_contract_signature')}</legend>
            <label class="choice"
              ><input type="radio" bind:group={method} value={PhotographyContractSignatureType.Typed} />
              {$t('frameleaf_clients_contract_use_typed')}</label
            >
            <label class="choice"
              ><input
                type="radio"
                bind:group={method}
                value={PhotographyContractSignatureType.Drawn}
                onchange={clear}
              />
              {$t('frameleaf_clients_contract_draw')}</label
            >
          </fieldset>
          {#if method === PhotographyContractSignatureType.Typed}
            {#if name.trim()}<p class="typed" aria-hidden="true">{name}</p>{/if}
          {:else}
            <canvas
              bind:this={canvas}
              width={WIDTH}
              height={HEIGHT}
              aria-label={$t('frameleaf_clients_contract_pad_label')}
              onpointerdown={start}
              onpointermove={move}
              onpointerup={() => (drawing = false)}
              onpointercancel={() => (drawing = false)}
            ></canvas>
            <div><Button disabled={!drawn} onclick={clear}>{$t('frameleaf_clients_contract_clear')}</Button></div>
          {/if}
          <label class="consent"
            ><input type="checkbox" bind:checked={consent} />
            {$t('frameleaf_clients_contract_consent')}</label
          >
          {#if phase === 'sign-error'}<p role="alert" class="error">
              {$t('frameleaf_clients_contract_sign_error')}
            </p>{/if}
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim() || !consent || (method === PhotographyContractSignatureType.Drawn && !drawn)}
            >{$t('frameleaf_clients_contract_sign')}</Button
          >
        </form>
      {/if}
    </section>
    {#if contract?.studio.email}
      <a class="contact" href="mailto:{contract.studio.email}"
        >{$t('frameleaf_clients_contract_contact', { values: { studio: contract.studio.name } })}</a
      >
    {/if}
  </div>
</main>

<style>
  @font-face {
    font-family: 'Contract Script';
    src: url('/fonts/great-vibes.ttf');
    font-display: swap;
  }
  .sign {
    min-height: 100dvh;
    padding-block: clamp(20px, 8vh, 80px) 30px;
    background: #f3f5f0;
    color: #1d1d1f;
    --fl-panel: #fff;
    --fl-raised: #f2f5ef;
  }
  .inner {
    max-width: 620px;
    margin: 0 auto;
    padding-inline: 16px;
    display: grid;
    gap: 20px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 11px;
    font:
      1.25rem Georgia,
      serif;
  }
  header span {
    display: grid;
    place-items: center;
    width: 35px;
    height: 35px;
    border: 1px solid var(--fl-border);
    border-radius: 50%;
    color: var(--studio, inherit);
  }
  .card {
    display: grid;
    gap: 18px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    padding: clamp(20px, 5vw, 36px);
  }
  h1 {
    margin: 0;
    font:
      2rem/1.15 Georgia,
      serif;
  }
  p {
    margin: 0;
  }
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
  form {
    display: grid;
    gap: 18px;
  }
  label {
    display: grid;
    gap: 0.5rem;
  }
  input:not([type]) {
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.5rem;
    font: inherit;
  }
  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin: 0;
    padding: 8px 10px 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .choice,
  .consent {
    display: flex;
    align-items: start;
    gap: 8px;
  }
  .consent input,
  .choice input {
    margin-top: 4px;
    accent-color: var(--studio, var(--fl-accent));
  }
  canvas {
    width: 100%;
    height: 110px;
    touch-action: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: #fff;
  }
  .typed {
    font:
      2rem 'Contract Script',
      cursive;
  }
  dl {
    display: grid;
    gap: 8px;
    margin: 0;
    border-top: 1px solid var(--fl-border);
    padding-top: 12px;
  }
  dl > div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  dd {
    margin: 0;
    font-weight: 600;
  }
  summary {
    cursor: pointer;
    text-decoration: underline;
  }
  .download {
    justify-self: start;
    padding: 0.6rem 1rem;
    border-radius: var(--fl-radius-control);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-weight: 600;
    text-decoration: none;
  }
  .contact {
    color: var(--studio, var(--fl-accent));
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .contact {
    justify-self: center;
  }
  .error {
    color: var(--fl-error, #c23442);
  }
</style>
