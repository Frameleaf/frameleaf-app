<script lang="ts">
  /**
   * FL-705: how Frameleaf Cloud sees the studio website's own domain (`GET photography/site/domain`), and the
   * two records to add where the domain is managed, shown exactly as Cloud gives them. Shown once the
   * website is published with a domain; Cloud is told about it on publish (and again by "Check again").
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { copyToClipboard } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { photographySiteDomain, type StudioSiteDomainResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiContentCopy } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    /** The saved, published domain; the status is asked for again when it changes. */
    domain: string;
  }
  let { domain }: Props = $props();

  let answer = $state<StudioSiteDomainResponseDto | null>(null);
  let checking = $state(false);
  let failure = $state('');

  const check = async () => {
    checking = true;
    failure = '';
    try {
      answer = await photographySiteDomain();
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      checking = false;
    }
  };

  $effect(() => {
    if (domain) {
      void check();
    }
  });

  const site = $derived(answer?.site ?? null);
  const live = $derived(site?.status === 'active');
</script>

<div class="sdd" aria-busy={checking}>
  <p class="sdd-state" class:is-ok={live} role="status">
    {#if failure}
      {failure}
    {:else if answer?.problem}
      {answer.problem}
    {:else if site}
      {$t(`frameleaf_studio_domain_status_${site.status}`, { values: { domain: site.domain } })}
      {#if site.problem}{$t(`frameleaf_studio_domain_problem_${site.problem}`)}{/if}
    {:else if answer}
      {$t('frameleaf_studio_domain_unknown')}
    {:else}
      {$t('frameleaf_studio_domain_checking')}
    {/if}
  </p>
  {#if site && !live && site.status !== 'needs_plan' && site.records.length > 0}
    <div class="sdd-records" role="table" aria-label={$t('frameleaf_studio_domain_records')}>
      <div role="row">
        <span role="columnheader">{$t('frameleaf_remote_record_type')}</span>
        <span role="columnheader">{$t('frameleaf_remote_record_name')}</span>
        <span role="columnheader">{$t('frameleaf_studio_domain_value')}</span>
      </div>
      {#each site.records as record (record.type + record.name)}
        <div role="row">
          <span role="cell">{record.type}</span>
          <span role="cell">{record.name}</span>
          <span role="cell" class="sdd-value"
            >{record.value}<Button
              variant="quiet"
              label={$t('frameleaf_remote_copy', {
                values: { what: `${record.type} ${$t('frameleaf_studio_domain_value')}` },
              })}
              onclick={() => void copyToClipboard(record.value)}><Icon icon={mdiContentCopy} size="14" /></Button
            ></span
          >
        </div>
      {/each}
    </div>
  {/if}
  <div class="sdd-actions">
    {#if site?.status === 'needs_plan'}
      <a class="button primary" href={commandCenterUrl('cloud', 'cloud-plan')}
        >{$t('frameleaf_photography_publishing_cloud_plan')}</a
      >
    {:else if !live}
      <Button disabled={checking} onclick={() => void check()}>{$t('frameleaf_studio_domain_check')}</Button>
    {/if}
  </div>
</div>

<style>
  .sdd {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .sdd-state {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .sdd-state.is-ok {
    color: var(--fl-accent-strong, var(--fl-accent));
  }
  .sdd-records {
    display: grid;
    gap: 4px;
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .sdd-records div {
    display: grid;
    grid-template-columns: 60px minmax(0, 1fr) minmax(0, 1.4fr);
    gap: 10px;
    align-items: center;
    padding: 6px 10px;
    border-radius: var(--fl-radius-sm, 6px);
    background: var(--fl-raised);
    overflow-wrap: anywhere;
  }
  .sdd-records div:first-child {
    background: none;
    color: var(--fl-muted);
  }
  .sdd-value {
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: space-between;
  }
  .sdd-actions:empty {
    display: none;
  }
</style>
