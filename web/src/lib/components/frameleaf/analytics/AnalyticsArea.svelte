<script lang="ts">
  /**
   * The command center's Library analytics area (FL-79): where the template mounts
   * `SettingsAnalytics.jsx`. It reads the scope and range from the address (`?scope=`, `?range=`)
   * and asks the server for that report, so a link to one account or library opens it directly and
   * switching areas never reloads the settings forms.
   */
  import { page } from '$app/state';
  import LibraryAnalytics from '$lib/components/frameleaf/analytics/LibraryAnalytics.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import {
    AnalyticsRange,
    getAnalyticsReport,
    getAnalyticsScopes,
    type AnalyticsReportResponseDto,
    type AnalyticsScopeOptionDto,
  } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  const range = $derived(
    page.url.searchParams.get('range') === AnalyticsRange.$90Days ? AnalyticsRange.$90Days : AnalyticsRange.Year,
  );
  const requested = $derived(page.url.searchParams.get('scope') ?? 'all');

  let scopes = $state<AnalyticsScopeOptionDto[]>();
  let report = $state<AnalyticsReportResponseDto>();
  let failed = $state(false);
  /** True while a changed scope or range is read; the last report stays, dimmed and inert, until it lands. */
  let loading = $state(true);
  let attempt = $state(0);

  $effect(() => {
    const wanted = { scope: requested, range };
    void attempt;
    let cancelled = false;
    loading = true;
    failed = false;
    void (async () => {
      try {
        scopes ??= (await getAnalyticsScopes()).scopes;
        // An unknown or no-longer-available scope falls back to the whole server.
        const scope = scopes.some((option) => option.value === wanted.scope) ? wanted.scope : 'all';
        const next = await getAnalyticsReport({ scope, range: wanted.range });
        if (!cancelled) {
          report = next;
          loading = false;
        }
      } catch {
        if (!cancelled) {
          // Another selection's figures never stand in for the one that could not be read.
          report = undefined;
          failed = true;
          loading = false;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

{#if report}
  <!--
    The figures update in place: while the next report is read the last one is dimmed and cannot be
    used (its export would be the previous selection's), then the new values swap in so the rings
    and counts animate between them (design review finding 69).
  -->
  <div class="report" class:busy={loading} aria-busy={loading} inert={loading}>
    <LibraryAnalytics {report} />
  </div>
  {#if loading}<p class="sr-only" role="status">{$t('frameleaf_analytics_loading')}</p>{/if}
{:else}
  <!-- The page keeps its name while the report loads or when it could not be read. -->
  <header class="heading">
    <SettingsOverline>{$t('frameleaf_analytics_eyebrow')}</SettingsOverline>
    <h1>{$t('frameleaf_analytics_heading')}</h1>
    <p>{$t('frameleaf_analytics_subheading')}</p>
  </header>
  {#if failed}
    <InlineError message={$t('frameleaf_analytics_load_failed')} onRetry={() => attempt++} />
  {:else}
    <div class="loading" role="status" aria-busy="true">
      <span class="sr-only">{$t('frameleaf_analytics_loading')}</span>
      <Skeleton variant="block" height="11rem" />
      <Skeleton variant="block" height="18rem" />
    </div>
  {/if}
{/if}

<style>
  .report {
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .report.busy {
    opacity: 0.6;
  }
  /* The same heading LibraryAnalytics draws, so nothing moves when the report lands. */
  .heading {
    margin-bottom: 22px;
  }
  .heading h1 {
    margin: 0;
    font-size: var(--fl-font-display);
    font-weight: 550;
    letter-spacing: -0.9px;
  }
  .heading p {
    margin: 6px 0 0;
    color: var(--fl-muted);
  }
  .loading {
    display: grid;
    gap: var(--fl-space-5);
    padding: var(--fl-space-2) 0;
  }
</style>
