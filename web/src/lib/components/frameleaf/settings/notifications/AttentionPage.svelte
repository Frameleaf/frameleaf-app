<script lang="ts">
  /**
   * Notifications › What needs your attention (FL-421, the approved prototype's `Alerts` in
   * `settings-v2/server/notifications.jsx`): one answer at the top, then what needs the administrator
   * now, each with the page that puts it right, then what Frameleaf looks for and how each check came
   * out. Everything is the server's own reading (`getAttention`), made when the page opens.
   *
   * The prototype's "Tell me when" choices (in the app, by email), the summary email and "What you
   * were told lately" need the server to send these alerts, which it does not do yet; until it does,
   * each row says how its check came out instead of offering a switch that would do nothing.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Tell, { type TellRow } from '$lib/components/frameleaf/settings/kit/Tell.svelte';
  import {
    attentionCheckRows,
    attentionHero,
    attentionView,
    type AttentionSayings,
    type Words,
  } from '$lib/frameleaf/attention';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getAttention, type AttentionResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiBellAlertOutline, mdiBellCheckOutline, mdiBellOffOutline, mdiChevronRight } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let response = $state<AttentionResponseDto | null>(null);
  let failed = $state(false);

  const load = async () => {
    failed = false;
    try {
      response = await getAttention();
    } catch {
      failed = true;
    }
  };
  onMount(() => {
    void load();
  });

  const words = ({ key, values }: Words) => $t(key, { values });
  const say = $derived<AttentionSayings>({
    size: (bytes) => getByteUnitString(bytes, $locale),
    list: (names) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names),
    words,
    locale: $locale,
    now: response ? new Date(response.checkedAt) : undefined,
  });

  const views = $derived(response ? response.items.map((item) => attentionView(item, say)) : []);
  const hero = $derived(response ? attentionHero(response.items, response.checks, say) : null);
  const HERO_ICONS = {
    good: mdiBellCheckOutline,
    warn: mdiBellAlertOutline,
    bad: mdiBellAlertOutline,
    quiet: mdiBellOffOutline,
  };

  const checks = $derived(response ? attentionCheckRows(response.checks) : []);
  const tellRows = $derived<TellRow[]>(
    checks.map((check) => ({
      id: check.kind,
      label: words(check.label),
      help: words(check.help),
      link: { text: words(check.link.text), href: check.link.href },
    })),
  );
  const stateOf = (row: TellRow) => checks.find((check) => check.kind === row.id)?.state;
</script>

<KitPage>
  {#if failed}
    <InlineError message={$t('frameleaf_attention_load_failed')} onRetry={load} />
  {:else if !response || !hero}
    <div class="loading" role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="8.5rem" />
      <Skeleton variant="block" height="16rem" />
    </div>
  {:else}
    <Hero
      tone={hero.tone}
      icon={HERO_ICONS[hero.tone]}
      title={words(hero.title)}
      body={words(hero.body)}
      label={$t('frameleaf_attention_hero_label')}
    />

    {#if views.length > 0}
      <Section title={$t('frameleaf_attention_now_title')}>
        <ItemList>
          {#each views as view (view.id)}
            <Item
              icon={view.icon}
              name={words(view.title)}
              detail={words(view.detail)}
              tone={view.tone}
              status={words(view.level)}
              note={view.since ? words(view.since) : undefined}
            >
              {#snippet action()}
                <a class="button" href={view.action.href}>
                  {words(view.action.label)}<Icon icon={mdiChevronRight} size="16" aria-hidden />
                </a>
              {/snippet}
            </Item>
          {/each}
        </ItemList>
      </Section>
    {/if}

    <Section title={$t('frameleaf_attention_checks_title')} description={$t('frameleaf_attention_checks_description')}>
      <Tell
        heading={$t('frameleaf_attention_checks_title')}
        columns={[$t('frameleaf_attention_checks_now')]}
        rows={tellRows}
      >
        {#snippet cell(row)}
          {@const state = stateOf(row)}
          {#if state}
            <Pill tone={state.tone}>{words(state.words)}</Pill>
          {/if}
        {/snippet}
      </Tell>
    </Section>
  {/if}
</KitPage>

<style>
  .loading {
    display: grid;
    gap: var(--fl-space-6);
  }
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  a.button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
