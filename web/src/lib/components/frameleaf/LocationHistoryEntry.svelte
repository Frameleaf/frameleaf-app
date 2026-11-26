<script lang="ts">
  /** FL-999: the short "Use your location history" section at the foot of Fix locations. */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { historySpan, sourceState } from '$lib/frameleaf/location-history';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getLocationHistorySources,
    getUtilitiesSummary,
    type LocationHistorySourceResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let sources = $state<LocationHistorySourceResponseDto[]>([]);
  let withoutPlace = $state<number>();

  const added = $derived(sources.filter((source) => sourceState(source) === 'added'));
  const span = $derived(historySpan(added));
  const date = (iso: string) => DateTime.fromISO(iso, { locale: $locale }).toLocaleString(DateTime.DATE_FULL);

  const load = async () => {
    // The section is an extra on this page: if it cannot be read it still offers the way in.
    try {
      sources = (await getLocationHistorySources()) ?? [];
    } catch {
      sources = [];
    }
    try {
      withoutPlace = (await getUtilitiesSummary())?.withoutPlace;
    } catch {
      withoutPlace = undefined;
    }
  };
  onMount(() => {
    void load();
  });
</script>

<div class="entry">
  <KitPage>
    <Section
      title={$t('frameleaf_location_history_title')}
      description={$t('frameleaf_location_history_entry_description')}
    >
      <Row
        label={span
          ? $t('frameleaf_location_history_files_summary', {
              values: { count: added.length, from: date(span.first), to: date(span.last) },
            })
          : $t('frameleaf_location_history_empty_title')}
        help={span && withoutPlace !== undefined
          ? `${$t('frameleaf_utilities_state_no_place', { values: { count: withoutPlace } })}. ${$t('frameleaf_location_history_entry_promise')}`
          : $t('frameleaf_location_history_entry_promise')}
      >
        <Button
          label={$t('frameleaf_utilities_open_tool', { values: { name: $t('frameleaf_location_history_title') } })}
          onclick={() => void goto(Route.locationHistoryUtility())}
          >{$t('open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
        >
      </Row>
    </Section>
  </KitPage>
</div>

<style>
  .entry {
    margin-top: var(--fl-space-6);
  }
</style>
