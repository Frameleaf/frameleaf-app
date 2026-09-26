<script lang="ts">
  import { ruleChips, type RuleChip, type RuleDraft } from '$lib/frameleaf/classification-rules';
  import type { PersonResponseDto, TagResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccountOutline,
    mdiArchiveArrowDownOutline,
    mdiCalendarRange,
    mdiEyeOutline,
    mdiImageOutline,
    mdiTagOutline,
    mdiVideoOutline,
  } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  /** A smart album's rule as chips (FL-60), ported from `RuleChips` in `CollectionHeader.jsx`. */
  interface Props {
    rule: RuleDraft;
    people?: PersonResponseDto[];
    tags?: TagResponseDto[];
  }

  let { rule, people = [], tags = [] }: Props = $props();

  const formatDay = (value: string) =>
    new Date(`${value}T00:00:00Z`).toLocaleDateString($locale ?? undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

  const chips = $derived(
    ruleChips(
      rule,
      {
        people: new Map(people.map((person) => [person.id, person.name])),
        tags: new Map(tags.map((tag) => [tag.id, tag.value])),
      },
      formatDay,
    ),
  );

  const iconFor = (chip: RuleChip) =>
    ({
      person: mdiAccountOutline,
      tag: mdiTagOutline,
      date: mdiCalendarRange,
      media: rule.mediaType === 'video' ? mdiVideoOutline : mdiImageOutline,
      visual: mdiEyeOutline,
      archive: mdiArchiveArrowDownOutline,
    })[chip.icon];
</script>

{#if chips.length > 0}
  <ul class="chips" aria-label={$t('frameleaf_rules_chips_label')}>
    {#each chips as chip (chip.icon)}
      <li>
        <Icon icon={iconFor(chip)} size="15" />
        {$t(chip.key, { values: chip.values })}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 26px;
    padding: 3px 10px 3px 8px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
  }
  li :global(svg) {
    color: var(--fl-muted);
  }
</style>
