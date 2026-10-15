<script lang="ts">
  /**
   * Things to fix (FL-366, after the approved prototype `settings-v2/care/fixes.jsx` `ThingsToFix`):
   * everything Frameleaf has found that needs a decision, in one list. It replaces Library care →
   * Repair suggestions, which was three switches and nothing else. Every account opens it: an
   * administrator sees the whole household, a member their own library.
   *
   * Each row says how many are waiting and opens its list. The two kinds of suggestion that can be
   * switched off (`libraryCare.livePhotoRepair`, `libraryCare.rawRecovery`) keep their switch on the
   * row, for administrators only: they are server settings. The look-alike switch is on Duplicates.
   *
   * The counts are the ones the app already keeps: Library Care's queues (missing, damaged,
   * look-alike groups), the file checks' lists (the larger of the two, so a file is never counted
   * twice) and the Live Photo pairs found. RAW originals have no count of their own yet, so that row
   * says only whether Frameleaf is looking.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { utilitiesUrl } from '$lib/frameleaf/utilities';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import {
    getIntegrityReportSummary,
    getLivePhotoCandidates,
    getSummary,
    IntegrityReport,
    type IntegrityReportSummaryResponseDto,
    type LivePhotoCandidatesResponseDto,
    type MediaHealthSummaryResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiFileAlertOutline,
    mdiFileQuestionOutline,
    mdiImageMultipleOutline,
    mdiMotionPlayOutline,
    mdiRaw,
    mdiShieldAlertOutline,
    mdiWrenchOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const isAdmin = $derived(authManager.user.isAdmin);
  const settingsDraft = getSystemConfigDraft();
  /** The switches are server settings: only an administrator, inside the settings page, has them. */
  const care = $derived(isAdmin ? settingsDraft?.draft.libraryCare : undefined);
  const held = $derived(featureFlagsManager.value.configFile);

  let summary = $state<MediaHealthSummaryResponseDto>();
  let integrity = $state<IntegrityReportSummaryResponseDto>();
  let live = $state<LivePhotoCandidatesResponseDto>();
  let loaded = $state(false);

  $effect(() => {
    const admin = isAdmin;
    let current = true;
    loaded = false;
    void Promise.all([
      getSummary(admin ? { allAccounts: true } : {}).catch(() => undefined),
      admin ? getIntegrityReportSummary().catch(() => undefined) : Promise.resolve(undefined),
      getLivePhotoCandidates().catch(() => undefined),
    ]).then(([health, reports, pairs]) => {
      if (!current) {
        return;
      }
      summary = health;
      integrity = reports;
      live = pairs;
      loaded = true;
    });
    return () => {
      current = false;
    };
  });

  const queues = $derived(summary?.queues);
  const missing = $derived(Math.max(queues?.missing ?? 0, integrity?.[IntegrityReport.MissingFile] ?? 0));
  const damaged = $derived(
    Math.max(
      (queues?.damagedConfirmed ?? 0) + (queues?.damagedSuspected ?? 0),
      integrity?.[IntegrityReport.ChecksumMismatch] ?? 0,
    ),
  );
  const lookAlikes = $derived(queues?.duplicates ?? 0);

  /** Whether Frameleaf looks for each switchable kind: the setting being edited, else what the server says. */
  const lookingForLive = $derived(care ? care.livePhotoRepair : (live?.suggestionsEnabled ?? true));
  const lookingForRaw = $derived(care ? care.rawRecovery : (summary?.care.rawRecovery ?? true));
  const pairs = $derived(lookingForLive ? (live?.total ?? 0) : 0);

  const setLive = (value: boolean) => {
    const draft = settingsDraft?.draft;
    if (draft?.libraryCare) {
      draft.libraryCare.livePhotoRepair = value;
    }
  };
  const setRaw = (value: boolean) => {
    const draft = settingsDraft?.draft;
    if (draft?.libraryCare) {
      draft.libraryCare.rawRecovery = value;
    }
  };

  const attention = $derived(missing + damaged);
  const suggestions = $derived(pairs + lookAlikes);

  const hero = $derived.by(() => {
    if (attention > 0) {
      return {
        tone: 'warn' as const,
        icon: mdiShieldAlertOutline,
        title: $t('frameleaf_care_fix_hero_attention', { values: { count: attention } }),
        body: [
          $t('frameleaf_care_fix_hero_attention_body', { values: { missing, damaged } }),
          suggestions > 0 ? $t('frameleaf_care_fix_hero_also', { values: { count: suggestions } }) : '',
          $t('frameleaf_care_fix_nothing_changes'),
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    if (suggestions > 0) {
      return {
        tone: 'good' as const,
        icon: mdiWrenchOutline,
        title: $t('frameleaf_care_fix_hero_waiting', { values: { count: suggestions } }),
        body: $t('frameleaf_care_fix_nothing_changes'),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCheckCircleOutline,
      title: $t('frameleaf_care_fix_hero_none'),
      body: $t('frameleaf_care_fix_hero_none_body'),
    };
  });

  type Row = {
    id: string;
    icon: string;
    name: string;
    detail: string;
    /** Undefined when the app keeps no count for this kind. */
    count?: number;
    unit: 'found' | 'waiting' | 'groups';
    note: string;
    tone: KitTone;
    /** The row's switch, for an administrator. */
    looking?: { on: boolean; set: (value: boolean) => void };
    /** Where Review goes; none when this reader has no list to open. */
    href?: string;
    duplicates?: boolean;
  };

  const rows = $derived.by((): Row[] => {
    const fromChecks = isAdmin ? commandCenterUrl('care', 'integrity-checks') : undefined;
    const all: (Row | false)[] = [
      {
        id: 'missing',
        icon: mdiFileQuestionOutline,
        name: $t('frameleaf_care_fc_missing_name'),
        detail: $t('frameleaf_care_fc_missing_detail'),
        count: missing,
        unit: 'found',
        note: isAdmin ? $t('frameleaf_care_fix_from_checks') : $t('frameleaf_care_fix_admin_fixes'),
        tone: 'warn',
        href: fromChecks,
      },
      {
        id: 'damaged',
        icon: mdiFileAlertOutline,
        name: $t('frameleaf_care_fc_damaged_name'),
        detail: $t('frameleaf_care_fc_damaged_detail'),
        count: damaged,
        unit: 'found',
        note: isAdmin ? $t('frameleaf_care_fix_from_checks') : $t('frameleaf_care_fix_admin_fixes'),
        tone: 'warn',
        href: fromChecks,
      },
      {
        id: 'live',
        icon: mdiMotionPlayOutline,
        name: $t('frameleaf_care_fix_live_name'),
        detail: $t('frameleaf_care_fix_live_detail'),
        count: pairs,
        unit: 'waiting',
        note: '',
        tone: 'warn',
        looking: { on: lookingForLive, set: setLive },
        href: utilitiesUrl('live-photos', { from: 'care' }),
      },
      // RAW originals are matched while missing files are searched for, which only an administrator can do.
      isAdmin && {
        id: 'raw',
        icon: mdiRaw,
        name: $t('frameleaf_care_fix_raw_name'),
        detail: $t('frameleaf_care_fix_raw_detail'),
        unit: 'waiting',
        note: $t('frameleaf_care_fix_raw_note'),
        tone: 'good',
        looking: { on: lookingForRaw, set: setRaw },
        href: utilitiesUrl('missing-media', { from: 'care' }),
      },
      {
        id: 'alike',
        icon: mdiImageMultipleOutline,
        name: $t('frameleaf_care_fix_alike_name'),
        detail: $t('frameleaf_care_fix_alike_detail'),
        count: lookAlikes,
        unit: 'groups',
        note: isAdmin ? $t('frameleaf_care_fix_alike_note') : '',
        tone: 'warn',
        href: utilitiesUrl('duplicates', { from: 'care' }),
        duplicates: isAdmin,
      },
    ];
    return all.filter((row): row is Row => row !== false);
  });

  const rowState = (row: Row): { tone: KitTone; status?: string; note?: string } => {
    if (row.looking && !row.looking.on) {
      return { tone: 'off', status: $t('frameleaf_care_fix_not_looking'), note: $t('frameleaf_care_fix_kept') };
    }
    if (row.count === undefined) {
      return { tone: 'good', status: $t('frameleaf_care_fix_looking'), note: row.note || undefined };
    }
    if (row.count === 0) {
      return { tone: 'good', status: $t('frameleaf_care_fix_none'), note: row.note || undefined };
    }
    return {
      tone: row.tone,
      status: $t(`frameleaf_care_fix_count_${row.unit}`, { values: { count: row.count } }),
      note: row.note || undefined,
    };
  };
</script>

<KitPage>
  <Hero
    tone={loaded ? hero.tone : 'quiet'}
    icon={hero.icon}
    title={loaded ? hero.title : $t('frameleaf_care_fix_loading')}
    body={loaded ? hero.body : undefined}
    label={$t('frameleaf_care_fix_title')}
  />

  <Section
    title={$t('frameleaf_care_fix_list_title')}
    description={care ? $t('frameleaf_care_fix_list_description') : $t('frameleaf_care_fix_list_description_member')}
  >
    <ItemList>
      {#each rows as row (row.id)}
        {@const state = rowState(row)}
        {@const off = !!row.looking && !row.looking.on}
        <Item
          icon={row.icon}
          {off}
          name={row.name}
          detail={row.detail}
          tone={loaded ? state.tone : 'off'}
          status={loaded ? state.status : undefined}
          note={loaded ? state.note : undefined}
        >
          {#snippet measure()}
            {#if care && row.looking}
              <Switch
                label={$t('frameleaf_care_fix_look_for', { values: { name: row.name } })}
                checked={row.looking.on}
                {held}
                onChange={row.looking.set}
              />
            {:else if row.duplicates}
              <TextLink href={commandCenterUrl('care', 'duplicates')}
                >{$t('frameleaf_care_fix_open_duplicates')}</TextLink
              >
            {/if}
          {/snippet}
          {#snippet action()}
            {#if row.href && !off && (row.count === undefined || row.count > 0)}
              {@const href = row.href}
              <Button
                label={$t('frameleaf_care_fix_review_named', { values: { name: row.name } })}
                onclick={() => goto(href)}
              >
                {$t('frameleaf_care_fix_review')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
              </Button>
            {/if}
          {/snippet}
        </Item>
      {/each}
    </ItemList>
  </Section>
</KitPage>
