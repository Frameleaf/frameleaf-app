<script lang="ts">
  /**
   * The command center's Library analytics area (FL-79): where the template mounts
   * `SettingsAnalytics.jsx`. It reads the scope and range from the address (`?scope=`, `?range=`)
   * and asks the server for that report, so a link to one account or library opens it directly and
   * switching areas never reloads the settings forms.
   */
  import { page } from '$app/state';
  import LibraryAnalytics from '$lib/components/frameleaf/analytics/LibraryAnalytics.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AnalyticsRange,
    getAnalyticsReport,
    getAnalyticsScopes,
    type AnalyticsReportResponseDto,
    type AnalyticsScopeOptionDto,
  } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  const range = $derived(
    page.url.searchParams.get('range') === AnalyticsRange.$90Days ? AnalyticsRange.$90Days : AnalyticsRange.Year,
  );
  const requested = $derived(page.url.searchParams.get('scope') ?? 'all');

  let scopes = $state<AnalyticsScopeOptionDto[]>();
  let report = $state<AnalyticsReportResponseDto>();
  let error = $state<string>();

  $effect(() => {
    const wanted = { scope: requested, range };
    let cancelled = false;
    report = undefined;
    error = undefined;
    void (async () => {
      try {
        scopes ??= (await getAnalyticsScopes()).scopes;
        // An unknown or no-longer-available scope falls back to the whole server.
        const scope = scopes.some((option) => option.value === wanted.scope) ? wanted.scope : 'all';
        const next = await getAnalyticsReport({ scope, range: wanted.range });
        if (!cancelled) {
          report = next;
          error = undefined;
        }
      } catch (error_) {
        if (!cancelled) {
          error = getServerErrorMessage(error_) ?? String(error_);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

{#if report && scopes}
  <LibraryAnalytics {scopes} {report} />
{:else if error}
  <p class="state" role="alert">{$t('frameleaf_analytics_load_failed')} · {error}</p>
{:else}
  <p class="state" role="status">{$t('frameleaf_analytics_loading')}</p>
{/if}

<style>
  .state {
    margin: 0;
    padding: 2rem 0;
    color: var(--fl-muted);
  }
</style>
