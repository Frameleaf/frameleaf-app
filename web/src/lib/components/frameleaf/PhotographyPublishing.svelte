<script lang="ts">
  /**
   * Clients › Studio › Publishing (approved design, 2026-11-04, `PhotographyWorkspace.jsx` `publishing`;
   * FL-1187). Self-hosted is today's studio website: its domain and its publish switch, the same record
   * Website edits. Cloud Pro (US$29.99 a month, owner decision 2026-11-04) adds a name on frameleaf.net and
   * a domain served for you. Once published with a domain, Frameleaf Cloud's view of it and the two records
   * to add show under the field (FL-705); the server's name on frameleaf.net lives in Remote access (FL-1197).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { photographyErrorKey } from '$lib/components/frameleaf/PhotographyStatus.svelte';
  import StudioDomainStatus from '$lib/components/frameleaf/StudioDomainStatus.svelte';
  import { siteRequest, type Site, type StudioSite } from '$lib/frameleaf/photography/workflow-api';
  import { validDomain } from '$lib/frameleaf/photography/studio-site';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiCheckboxBlankCircleOutline,
    mdiCloudOutline,
    mdiDownloadBoxOutline,
    mdiImageMultipleOutline,
    mdiServerOutline,
    mdiShieldCheckOutline,
    mdiWeb,
  } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Mode = 'self-hosted' | 'cloud';
  let mode = $state<Mode>('self-hosted');
  let stored = $state<StudioSite | null>(null);
  let domain = $state('');
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let disposed = false;

  const domainOk = $derived(validDomain(domain));
  const domainChanged = $derived(!!stored && domain.trim().toLowerCase() !== (stored.site.domain ?? ''));
  const published = $derived(!!stored?.site.enabled);
  const address = $derived(
    serverConfigManager.value.externalDomain || (typeof location === 'undefined' ? '' : location.origin),
  );
  const PARTS = [
    [mdiWeb, 'frameleaf_photography_publishing_part_website', 'frameleaf_photography_publishing_part_website_detail'],
    [
      mdiImageMultipleOutline,
      'frameleaf_photography_publishing_part_proofs',
      'frameleaf_photography_publishing_part_proofs_detail',
    ],
    [
      mdiDownloadBoxOutline,
      'frameleaf_photography_publishing_part_delivery',
      'frameleaf_photography_publishing_part_delivery_detail',
    ],
  ] as const;

  async function reload() {
    busy = true;
    error = '';
    try {
      const result = await siteRequest();
      if (!disposed) {
        stored = result;
        domain = result.site.domain ?? '';
      }
    } catch (error_) {
      if (!disposed) {
        error = $t(photographyErrorKey(error_));
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }

  /** Saves the domain and, when given, whether the website is published; the rest of the site stays as it is. */
  async function save(enabled = stored?.site.enabled ?? false) {
    if (!stored || !domainOk) {
      return;
    }
    await put({ ...stored.site, enabled, domain: domain.trim().toLowerCase() });
  }

  /** Stops publishing the site as it is stored; whatever is typed in the domain field is neither needed nor saved. */
  async function stop() {
    if (!stored) {
      return;
    }
    await put({ ...stored.site, enabled: false });
  }

  async function put(site: Site) {
    if (!stored || busy) {
      return;
    }
    busy = true;
    error = '';
    message = '';
    try {
      const result = await siteRequest('PUT', { expectedRevision: stored.revision, site });
      if (!disposed) {
        stored = result;
        domain = result.site.domain ?? '';
        message = result.site.enabled
          ? $t('frameleaf_photography_site_saved_published')
          : $t('frameleaf_photography_site_saved');
      }
    } catch (error_) {
      if (!disposed) {
        error = $t(photographyErrorKey(error_));
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }

  onMount(() => void reload());
  onDestroy(() => {
    disposed = true;
  });
</script>

<div class="phw-publishing" aria-busy={busy}>
  <div class="phw-publish-paths" role="group" aria-label={$t('frameleaf_photography_publishing_paths')}>
    <button type="button" aria-pressed={mode === 'self-hosted'} onclick={() => (mode = 'self-hosted')}>
      <Icon icon={mdiServerOutline} size="26" aria-hidden />
      <strong>{$t('frameleaf_photography_publishing_self_hosted')}</strong>
      <span>{$t('frameleaf_photography_publishing_self_hosted_body')}</span>
      <small>{$t('frameleaf_photography_publishing_self_hosted_note')}</small>
      <Icon icon={mode === 'self-hosted' ? mdiCheckCircleOutline : mdiCheckboxBlankCircleOutline} aria-hidden />
    </button>
    <button type="button" aria-pressed={mode === 'cloud'} onclick={() => (mode = 'cloud')}>
      <Icon icon={mdiCloudOutline} size="26" aria-hidden />
      <strong>{$t('frameleaf_photography_publishing_cloud')}</strong>
      <span>{$t('frameleaf_photography_publishing_cloud_body')}</span>
      <small>{$t('frameleaf_photography_publishing_cloud_price')}</small>
      <Icon icon={mode === 'cloud' ? mdiCheckCircleOutline : mdiCheckboxBlankCircleOutline} aria-hidden />
    </button>
  </div>

  {#if error}<p class="phw-notice" role="alert">{error}</p>{/if}
  {#if message}<p class="phd-status" role="status">{message}</p>{/if}

  <div class="phw-publish-layout">
    <section class="phw-publishing-form" aria-labelledby="phw-publishing-heading">
      <div class="phw-section-heading">
        <div>
          <h2 id="phw-publishing-heading">
            {mode === 'cloud'
              ? $t('frameleaf_photography_publishing_managed')
              : $t('frameleaf_photography_publishing_space')}
          </h2>
          <p>
            {mode === 'cloud'
              ? $t('frameleaf_photography_publishing_managed_body')
              : $t('frameleaf_photography_publishing_space_body')}
          </p>
        </div>
        <span class="phw-publish-state" class:is-live={published}
          >{published
            ? $t('frameleaf_photography_publishing_live')
            : $t('frameleaf_photography_publishing_not_live')}</span
        >
      </div>

      {#if mode === 'cloud'}
        <ul class="phw-pro-includes">
          <li>{$t('frameleaf_photography_publishing_cloud_name')}</li>
          <li>{$t('frameleaf_photography_publishing_cloud_domain')}</li>
          <li>{$t('frameleaf_photography_publishing_cloud_managed')}</li>
        </ul>
        <p class="phw-small">{$t('frameleaf_photography_publishing_cloud_soon')}</p>
        <a class="button primary" href={commandCenterUrl('cloud', 'cloud-plan')}
          >{$t('frameleaf_photography_publishing_cloud_plan')}</a
        >
      {:else}
        <label
          >{$t('frameleaf_photography_publishing_domain')}<input
            bind:value={domain}
            placeholder="yourstudio.example"
            autocomplete="off"
            aria-invalid={!domainOk}
            disabled={!stored}
          /><small
            >{domainOk
              ? $t('frameleaf_photography_publishing_domain_hint')
              : $t('frameleaf_photography_publishing_domain_invalid')}</small
          ></label
        >
        {#if published && stored?.site.domain}
          <StudioDomainStatus domain={stored.site.domain} />
        {/if}
        <div class="phw-pro-note">
          <Icon icon={mdiWeb} size="20" aria-hidden />
          <p>
            <strong>{$t('frameleaf_photography_publishing_pro_note_title')}</strong>
            {$t('frameleaf_photography_publishing_pro_note')}
          </p>
          <Button onclick={() => (mode = 'cloud')}>{$t('frameleaf_photography_publishing_see_cloud')}</Button>
        </div>
      {/if}

      <div class="phw-server-address">
        <span>{$t('frameleaf_photography_publishing_server')}</span>
        <strong>{address}</strong>
        <a href={commandCenterUrl('cloud', 'cloud-remote')}>{$t('frameleaf_photography_publishing_server_change')}</a>
      </div>

      {#if mode === 'self-hosted'}
        <div class="phd-actions">
          {#if published}
            <Button disabled={busy || !stored || !domainOk || !domainChanged} onclick={() => save()}
              >{$t('frameleaf_photography_publishing_save_domain')}</Button
            ><Button disabled={busy || !stored} onclick={stop}>{$t('frameleaf_photography_publishing_stop')}</Button
            >{#if stored}<a class="button" href={stored.url} target="_blank" rel="noopener"
                >{$t('frameleaf_photography_site_open')} ↗</a
              >{/if}
          {:else}
            <Button variant="primary" disabled={busy || !stored || !domainOk} onclick={() => save(true)}
              >{$t('frameleaf_photography_site_publish')}</Button
            >
          {/if}
        </div>
      {/if}

      <ul class="phw-publish-parts" aria-label={$t('frameleaf_photography_publishing_parts')}>
        {#each PARTS as [icon, name, detail] (name)}
          <li>
            <Icon {icon} size="18" aria-hidden />
            <span><strong>{$t(name)}</strong><small>{$t(detail)}</small></span>
          </li>
        {/each}
      </ul>
    </section>

    <aside class="phw-privacy">
      <Icon icon={mdiShieldCheckOutline} size="30" aria-hidden />
      <h2>{$t('frameleaf_photography_publishing_local_title')}</h2>
      <p>{$t('frameleaf_photography_publishing_local_body')}</p>
      <ul>
        <li>{$t('frameleaf_photography_publishing_local_originals')}</li>
        <li>{$t('frameleaf_photography_publishing_local_keys')}</li>
        <li>{$t('frameleaf_photography_publishing_local_online')}</li>
      </ul>
    </aside>
  </div>
</div>
