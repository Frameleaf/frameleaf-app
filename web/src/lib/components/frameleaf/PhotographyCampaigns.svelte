<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import {
    photographyCampaigns,
    photographyCampaignDeliveries,
    type PhotographyCampaignDeliveriesDto,
    photographySaveCampaign,
    photographyPreviewCampaign,
    photographyTestCampaign,
    photographyScheduleCampaign,
    photographyCancelCampaign,
    type PhotographyCampaignDto,
    type PhotographyCampaignSaveDto,
    type PhotographyCampaignPreviewDto,
    type PhotographyCampaignListDto,
  } from '@frameleaf/sdk';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';

  let { shoots }: { shoots: { id: string; name: string }[] } = $props();
  let data = $state<PhotographyCampaignListDto>();
  let draft = $state<PhotographyCampaignSaveDto>();
  let id = $state('');
  let revision = $state('');
  let preview = $state<PhotographyCampaignPreviewDto>();
  let when = $state('');
  let busy = $state(false);
  let error = $state(false);
  let tested = $state(false);
  let confirm = $state(false);
  let results = $state<PhotographyCampaignDeliveriesDto>();
  let disposed = false;
  let generation = 0;
  onDestroy(() => {
    disposed = true;
    generation++;
  });
  async function run(action: () => Promise<void>) {
    const current = generation;
    busy = true;
    error = false;
    try {
      await action();
    } catch {
      if (!disposed && current === generation) {
        error = true;
      }
    } finally {
      if (!disposed && current === generation) {
        busy = false;
      }
    }
  }
  async function reload() {
    const current = generation;
    const result = await photographyCampaigns();
    if (!disposed && current === generation) {
      data = result;
    }
  }
  onMount(() => {
    void run(reload);
    return onLibraryAccessChange(() => {
      generation++;
      data = undefined;
      draft = undefined;
      preview = undefined;
      results = undefined;
    });
  });
  function edit(row?: PhotographyCampaignDto) {
    id = row?.id ?? crypto.randomUUID();
    draft = row
      ? {
          name: row.name,
          templateKey: row.templateKey,
          subject: row.subject,
          body: row.body,
          audience: { ...row.audience },
        }
      : { name: '', templateKey: 'print-sale', subject: '', body: '', audience: { source: 'clients' } };
    preview = undefined;
    confirm = false;
    tested = false;
    when = '';
    if (!row) {
      chooseTemplate();
    }
  }
  function chooseTemplate() {
    if (!draft) {
      return;
    }
    const key = draft.templateKey.replaceAll('-', '_');
    draft.subject = $t(`campaign_${key}`);
    draft.body = $t(`campaign_${key}_body`);
  }
  async function save(showPreview: boolean) {
    if (!draft) {
      return;
    }
    const current = generation;
    const saved = await photographySaveCampaign({ id, photographyCampaignSaveDto: draft });
    if (disposed || current !== generation) { return; }
    revision = saved.revision;
    await reload();
    if (showPreview) {
      const rendered = await photographyPreviewCampaign({ id });
      if (!disposed && current === generation) { preview = rendered; }
    } else {
      draft = undefined;
    }
  }
  async function loadResults(campaignId: string) {
    const current = generation;
    const result = await photographyCampaignDeliveries({ id: campaignId });
    if (!disposed && current === generation) { results = result; }
  }
  async function send() {
    const current = generation;
    await photographyScheduleCampaign({
      id,
      photographyCampaignScheduleDto: {
        expectedRevision: revision,
        ...(when ? { scheduledFor: new Date(when).toISOString() } : {}),
      },
    });
    if (disposed || current !== generation) { return; }
    draft = undefined;
    preview = undefined;
    confirm = false;
    await reload();
  }
</script>

<section class="campaigns" aria-busy={busy}>
  <div class="actions">
    <h2>{$t('campaign_title')}</h2>
    <Button disabled={busy} onclick={() => edit()}>{$t('campaign_new')}</Button><Button
      disabled={busy}
      onclick={() => run(reload)}>{$t('refresh')}</Button
    >
  </div>
  {#if error}<p role="alert">{$t('campaign_error')}</p>{/if}
  {#if data && !data.mailReady}<p role="status">{$t('campaign_configure')}</p>{/if}
  {#if draft}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void run(() => save(true));
      }}
    >
      {#if preview}
        <h3>{$t('preview')}</h3>
        <p>{preview.sender} · {$t('campaign_recipients', { values: { count: preview.recipients } })}</p>
        <iframe title={$t('preview')} srcdoc={preview.html} sandbox="" referrerpolicy="no-referrer"></iframe>
        {#if tested}<p role="status">{$t('campaign_tested')}</p>{/if}
        <div class="actions">
          <Button
            disabled={busy}
            onclick={() => {
              preview = undefined;
              confirm = false;
            }}>{$t('edit')}</Button
          >
          <Button
            disabled={busy || !data?.mailReady}
            onclick={() =>
              run(async () => {
                await photographyTestCampaign({ id });
                tested = true;
              })}>{$t('campaign_test')}</Button
          >
          <Button
            disabled={busy || !data?.mailReady || preview.recipients === 0}
            onclick={() => {
              confirm = true;
            }}>{$t('campaign_send')}</Button
          >
        </div>
        {#if confirm}
          <label>{$t('campaign_date')}<input type="datetime-local" bind:value={when} /></label>
          <p>{$t('campaign_confirm')}</p>
          <Button variant="primary" disabled={busy} onclick={() => run(send)}
            >{when ? $t('campaign_schedule') : $t('campaign_send_now')}</Button
          >
        {/if}
      {:else}
        <label>{$t('name')}<input required maxlength="120" bind:value={draft.name} /></label>
        <div class="fields">
          <label
            >{$t('campaign_audience')}<select bind:value={draft.audience.source}
              ><option value="clients">{$t('campaign_clients')}</option><option value="leads"
                >{$t('campaign_leads')}</option
              ><option value="all">{$t('all')}</option><option value="shoot">{$t('campaign_shoot')}</option></select
            ></label
          >
          <label
            >{$t('template')}<select bind:value={draft.templateKey} onchange={chooseTemplate}
              ><option value="print-sale">{$t('campaign_print_sale')}</option><option value="review-request"
                >{$t('campaign_review_request')}</option
              ><option value="mini-session">{$t('campaign_mini_session')}</option></select
            ></label
          >
        </div>
        {#if draft.audience.source === 'shoot'}<label
            >{$t('campaign_shoot')}<select required bind:value={draft.audience.workflowId}
              ><option value="" disabled>{$t('frameleaf_photography_choose_shoot')}</option
              >{#each shoots as shoot (shoot.id)}<option value={shoot.id}>{shoot.name}</option>{/each}</select
            ></label
          >{/if}
        <label>{$t('campaign_subject')}<input required maxlength="200" bind:value={draft.subject} /></label>
        <label
          >{$t('campaign_message')}<textarea required maxlength="10000" rows="7" bind:value={draft.body}
          ></textarea></label
        >
        <div class="actions">
          <Button
            disabled={busy}
            onclick={() => {
              draft = undefined;
            }}>{$t('cancel')}</Button
          ><Button disabled={busy} onclick={() => run(() => save(false))}>{$t('save')}</Button><Button
            type="submit"
            disabled={busy}
            variant="primary">{$t('preview')}</Button
          >
        </div>
      {/if}
    </form>
  {:else if data}
    {#if data.items.length === 0}<p>{$t('campaign_empty')}</p>{/if}
    <ul>
      {#each data.items as campaign (campaign.id)}<li>
          <div>
            <h3>{campaign.name}</h3>
            <p>{$t(`campaign_status_${campaign.status}`)}</p>
            {#if campaign.scheduledFor}<time datetime={campaign.scheduledFor}
                >{new Date(campaign.scheduledFor).toLocaleString()}</time
              >{/if}
            {#if campaign.status !== 'draft'}<p>
                {$t('campaign_results', {
                  values: {
                    sent: campaign.sentCount,
                    failed: campaign.failedCount,
                    pending: campaign.pendingCount,
                    unsubscribed: campaign.unsubscribedCount,
                  },
                })}
              </p>
              {#if campaign.uncertainCount > 0}<p role="status">
                  {$t('campaign_uncertain', { values: { count: campaign.uncertainCount } })}
                </p>{/if}{/if}
          </div>
          {#if campaign.status !== 'draft'}<Button
              disabled={busy}
              onclick={() =>
                run(async () => {
                  await loadResults(campaign.id);
                })}>{$t('campaign_view_results')}</Button
            >{/if}
          {#if campaign.status === 'draft'}<Button disabled={busy} onclick={() => edit(campaign)}>{$t('edit')}</Button
            >{/if}
          {#if ['draft', 'scheduled'].includes(campaign.status)}<Button
              disabled={busy}
              onclick={() =>
                run(async () => {
                  await photographyCancelCampaign({ id: campaign.id });
                  await reload();
                })}>{$t('cancel')}</Button
            >{/if}
        </li>{/each}
    </ul>
  {/if}
  {#if results}<div class="mail">
      <div class="actions">
        <h3>{$t('campaign_view_results')}</h3>
        <Button
          onclick={() => {
            results = undefined;
          }}>{$t('close')}</Button
        >
      </div>
      <ul>
        {#each results.items as item (item.email)}<li>
            {item.name} · {item.email} · {$t(`campaign_delivery_${item.status}`)}
          </li>{/each}
      </ul>
    </div>{/if}
</section>

<style>
  .campaigns {
    display: grid;
    gap: 1.5rem;
    padding: 1.5rem;
    max-width: 60rem;
  }
  .actions,
  .fields {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    align-items: center;
  }
  form,
  label {
    display: grid;
    gap: 0.75rem;
  }
  form {
    gap: 1.5rem;
    max-width: 48rem;
  }
  label {
    flex: 1;
    min-width: 12rem;
  }
  input,
  select,
  textarea {
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.5rem;
    background: var(--fl-surface);
    color: inherit;
  }
  .mail {
    padding: 2rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.75rem;
  }
  iframe { width: 100%; min-height: 32rem; border: 1px solid var(--fl-border); border-radius: 0.75rem; background: white; }
  ul {
    display: grid;
    gap: 1rem;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    border-bottom: 1px solid var(--fl-border);
    padding: 1.25rem 0;
  }
  li > div {
    flex: 1;
    min-width: 14rem;
  }
  h3 {
    margin: 0;
  }
</style>
