<script lang="ts">
  import { page } from '$app/state';
  import {
    headingAnchor,
    helpCache,
    helpArticleUrl,
    helpScreenFor,
    renderHelpArticle,
    screenArticles,
    screenNameKey,
    searchHelp,
    type HelpHit,
  } from '$lib/frameleaf/help';
  import { leave, prefersReducedMotion } from '$lib/frameleaf/motion';
  import { openSupportDialog } from '$lib/frameleaf/system-dialogs';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { searchStore } from '$lib/stores/search.svelte';
  import { handlePromiseError } from '$lib/utils';
  import {
    askHelp,
    getHelpArticle,
    getHelpIndex,
    HelpAskRole,
    type HelpArticleDto,
    type HelpAskResponseDto,
    type HelpIndexResponseDto,
    type HelpAskTurnDto,
  } from '@frameleaf/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import {
    mdiArrowLeft,
    mdiArrowUp,
    mdiBookOpenOutline,
    mdiClose,
    mdiCreation,
    mdiExpansionCardVariant,
    mdiFileDocumentOutline,
    mdiLifebuoy,
    mdiLightbulbOnOutline,
    mdiMagnify,
    mdiMapMarkerOutline,
    mdiOpenInNew,
    mdiRefresh,
    mdiStop,
    mdiWifiOff,
  } from '@mdi/js';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * In-app help (FL-489), as approved in the prototype (`HelpPalette.jsx`, frameleaf-prototype #5): the
   * search palette's glass panel with the frameleaf.app help articles for the screen you're on, a
   * large search over every article, a reader, and Ask Frameleaf with numbered sources. Everything
   * comes through this server (`/help/*`): it keeps the articles, so help opens offline, and relays
   * questions with its hardware.
   */
  let { onClose: closed }: { onClose: () => void } = $props();

  type Turn = { role: 'user'; text: string } | { role: 'assistant'; result: HelpAskResponseDto };
  type Row = { key: string; action: () => void };
  const MAX_TURNS = 6;
  const STARTERS = [
    'frameleaf_help_panel_starter_share',
    'frameleaf_help_panel_starter_gpu',
    'frameleaf_help_panel_starter_backup',
    'frameleaf_help_panel_starter_faces',
  ] as const;

  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  let readerBody = $state<HTMLElement>();
  let readerTop = $state<HTMLElement>();
  let index = $state<HelpIndexResponseDto | undefined>(helpCache.index);
  let loadFailed = $state(false);
  let mode = $state<'help' | 'ask'>('help');
  let text = $state('');
  let topic = $state<string | null>(null);
  let reading = $state<{
    article: HelpArticleDto;
    heading: string | null;
    html: string | null;
    failed: boolean;
  } | null>(null);
  let turns = $state<Turn[]>([]);
  let asking = $state(false);
  let askProblem = $state<string | null>(null);
  let active = $state(-1);
  let askController: AbortController | undefined;

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const reducedMotion = $derived(prefersReducedMotion());
  const screen = $derived(helpScreenFor(page.url, authManager.user?.isAdmin ?? false));
  const screenName = $derived($t(screenNameKey(screen)));
  const forScreen = $derived(index ? screenArticles(index, screen) : []);
  const query = $derived(text.trim());
  const hits = $derived<HelpHit[]>(index && query && mode === 'help' ? searchHelp(index.articles, query) : []);
  const ids = $derived(new Set(index?.articles.map((article) => article.id)));
  const canAsk = $derived(!!index?.ask.enabled && !index.offline);
  const sections = $derived(
    index ? [...new Map(index.articles.map((article) => [article.section, article.sectionTitle]))] : [],
  );
  const topicArticles = $derived(index && topic ? index.articles.filter((article) => article.section === topic) : []);

  const article = (id: string) => index?.articles.find((item) => item.id === id);
  const anchorOf = (heading: string | null | undefined) => (heading ? headingAnchor(heading) : null);
  /** The guide a source cites, and the section if it names one. */
  const sourceTarget = (url: string) => {
    const [path, hash] = url.split('#', 2);
    const item = index?.articles.find((candidate) => candidate.url === path);
    return item ? { item, anchor: hash ? decodeURIComponent(hash) : null } : undefined;
  };

  /* Every row the arrow keys can reach, in screen order, with what Enter does. */
  const rows = $derived.by<Row[]>(() => {
    if (!index || reading) {
      return [];
    }
    if (mode === 'ask') {
      return turns.length > 0 || !canAsk ? [] : STARTERS.map((key) => ({ key, action: () => ask($t(key)) }));
    }
    if (query) {
      return [
        ...hits.map((hit) => ({ key: hit.article.id, action: () => open(hit.article, anchorOf(hit.heading?.title)) })),
        ...(canAsk ? [{ key: 'ask', action: () => ask(query) }] : []),
      ];
    }
    if (topic) {
      return topicArticles.map((item) => ({ key: item.id, action: () => open(item) }));
    }
    return [
      ...forScreen.map((item) => ({ key: item.id, action: () => open(item) })),
      ...(canAsk ? STARTERS.slice(0, 3).map((key) => ({ key, action: () => ask($t(key)) })) : []),
    ];
  });
  const rowAt = (key: string) => rows.findIndex((row) => row.key === key);
  const preview = $derived(
    (active >= 0 && rows[active] && article(rows[active].key)) || hits[0]?.article || forScreen[0],
  );

  const load = async () => {
    try {
      index = helpCache.index = await getHelpIndex();
      loadFailed = false;
    } catch {
      loadFailed = !index;
    }
  };
  handlePromiseError(load());

  let leaving = false;
  const onClose = () => {
    if (leaving) {
      return;
    }
    leaving = true;
    askController?.abort();
    leave(dialog, 'pop', closed, { backdrop: true });
  };
  onDestroy(() => askController?.abort());

  $effect(() => {
    if (!dialog || dialog.open) {
      return;
    }
    const previous = document.activeElement;
    dialog.showModal();
    input?.focus();
    // Shortcut handlers elsewhere stand down while the panel has focus
    searchStore.isSearchEnabled = true;
    return () => {
      searchStore.isSearchEnabled = false;
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  });

  const scrollToHeading = async (anchor: string | null) => {
    await tick();
    const target = anchor ? readerBody?.querySelector(`#${CSS.escape(anchor)}`) : readerTop;
    target?.scrollIntoView({ block: 'start' });
  };

  /** Opens a guide in the reader, at a heading's anchor if one is given. */
  async function open(item: HelpArticleDto, anchor: string | null = null) {
    active = -1;
    const cached = helpCache.articles.get(item.id);
    reading = { article: item, heading: anchor, html: cached ?? null, failed: false };
    if (!cached) {
      try {
        const [section, slug] = item.id.split('/', 2);
        const { markdown } = await getHelpArticle({ section, slug });
        const html = renderHelpArticle(markdown, index!.origin, ids);
        helpCache.articles.set(item.id, html);
        if (reading?.article.id === item.id) {
          reading.html = html;
        }
      } catch {
        if (reading?.article.id === item.id) {
          reading.failed = true;
        }
      }
    }
    await scrollToHeading(anchor);
  }

  async function ask(question: string) {
    const value = question.trim();
    if (!value || !canAsk || asking || turns.length >= MAX_TURNS * 2) {
      return;
    }
    mode = 'ask';
    reading = null;
    text = '';
    active = -1;
    askProblem = null;
    const history: HelpAskTurnDto[] = turns.slice(-MAX_TURNS).map((turn) =>
      turn.role === 'user'
        ? { role: HelpAskRole.User, text: turn.text }
        : {
            role: HelpAskRole.Assistant,
            text: turn.result.blocks
              .map((block) => block.text)
              .join('\n\n')
              .slice(0, 4000),
          },
    );
    turns = [...turns, { role: 'user', text: value }];
    asking = true;
    askController = new AbortController();
    try {
      const result = await askHelp(
        { helpAskDto: { question: value, turns: history, screen } },
        { signal: askController.signal },
      );
      turns = [...turns, { role: 'assistant', result }];
    } catch (error) {
      if (!askController.signal.aborted) {
        const status = (error as { status?: number }).status;
        askProblem = $t(
          status === 429
            ? 'frameleaf_help_panel_ask_busy'
            : status === 403
              ? 'frameleaf_help_panel_ask_off'
              : 'frameleaf_help_panel_ask_failed',
        );
      }
    } finally {
      asking = false;
    }
  }

  const stop = () => {
    askController?.abort();
    asking = false;
    turns = turns.slice(0, -1);
  };

  const back = () => {
    if (reading) {
      reading = null;
    } else if (topic) {
      topic = null;
    } else if (mode === 'ask' && turns.length === 0) {
      mode = 'help';
    } else {
      return false;
    }
    active = -1;
    input?.focus();
    return true;
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + rows.length) % rows.length;
        dialog?.querySelector(`#hp-item-${active}`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handlePromiseError(ask(query));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = active >= 0 ? rows.at(active) : undefined;
      if (row) {
        row.action();
      } else if (mode === 'ask' || hits.length === 0) {
        handlePromiseError(ask(query));
      } else {
        handlePromiseError(open(hits[0].article, anchorOf(hits[0].heading?.title)));
      }
    }
  };

  // Links inside an article: another guide opens in the reader, a heading scrolls to it.
  const onReaderClick = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest('a');
    if (!link || !(link.dataset.helpArticle || link.dataset.helpHeading)) {
      return;
    }
    event.preventDefault();
    const target = link.dataset.helpArticle ? article(link.dataset.helpArticle) : reading?.article;
    if (target && target.id !== reading?.article.id) {
      handlePromiseError(open(target, link.dataset.helpHeading ?? null));
    } else if (link.dataset.helpHeading && reading) {
      reading.heading = link.dataset.helpHeading;
      handlePromiseError(scrollToHeading(link.dataset.helpHeading));
    }
  };

  const updated = $derived(
    index?.updatedAt
      ? new Date(index.updatedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : null,
  );
  const site = $derived(index ? new URL(index.origin).host : 'frameleaf.app');
</script>

{#snippet articleRow(item: HelpArticleDto, heading: string | null, section: string | null)}
  {@const at = rowAt(item.id)}
  <div
    id="hp-item-{at}"
    role="option"
    tabindex="-1"
    aria-selected={at === active}
    class="sp-row hp-row"
    class:active={at === active}
    onmouseenter={() => (active = at)}
    onclick={() => handlePromiseError(open(item, anchorOf(heading)))}
    onkeydown={() => {}}
  >
    <Icon icon={mdiFileDocumentOutline} size="16" aria-hidden={true} />
    <span class="hp-two">
      <strong>
        {item.title}{#if heading}<em class="hp-heading">{` › ${heading}`}</em>{/if}
      </strong>
      <small>{item.description}</small>
    </span>
    {#if section}<small class="hp-section">{section}</small>{/if}
  </div>
{/snippet}

{#snippet promptRow(key: string, label: string, icon: string, hint?: string)}
  {@const at = rowAt(key)}
  <div
    id="hp-item-{at}"
    role="option"
    tabindex="-1"
    aria-selected={at === active}
    class="sp-row"
    class:active={at === active}
    onmouseenter={() => (active = at)}
    onclick={() => rows[at]?.action()}
    onkeydown={() => {}}
  >
    <Icon {icon} size="16" aria-hidden={true} />
    <span>{label}</span>
    {#if hint}<kbd>{hint}</kbd>{/if}
  </div>
{/snippet}

<dialog
  bind:this={dialog}
  class="search-palette help-palette frameleaf fl-continuous-corners"
  class:reduced-motion={reducedMotion}
  data-theme={appTheme}
  aria-label={$t('frameleaf_help_panel_title')}
  oncancel={(event) => {
    event.preventDefault();
    if (!back()) {
      onClose();
    }
  }}
  onclick={(event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }}
>
  <form onsubmit={(event) => event.preventDefault()}>
    <div class="sp-field">
      <Icon icon={mode === 'ask' ? mdiCreation : mdiMagnify} size="22" aria-hidden={true} />
      <div class="sp-tokens">
        <input
          bind:this={input}
          bind:value={text}
          aria-label={mode === 'ask' ? $t('frameleaf_help_panel_ask') : $t('frameleaf_help_panel_search')}
          role="combobox"
          aria-expanded="true"
          aria-controls="hp-results"
          aria-activedescendant={active >= 0 ? `hp-item-${active}` : undefined}
          autocomplete="off"
          maxlength={4000}
          onkeydown={onKeydown}
          disabled={mode === 'ask' && !canAsk}
          oninput={() => {
            active = -1;
            if (mode === 'help') {
              reading = null;
              topic = null;
            }
          }}
          placeholder={mode === 'ask'
            ? turns.length > 0
              ? $t('frameleaf_help_panel_followup_placeholder')
              : $t('frameleaf_help_panel_ask_placeholder')
            : $t('frameleaf_help_panel_search_placeholder')}
        />
      </div>
      {#if text}
        <button
          type="button"
          class="sp-icon-button"
          aria-label={$t('frameleaf_help_panel_clear')}
          onclick={() => {
            text = '';
            input?.focus();
          }}
        >
          <Icon icon={mdiClose} size="16" aria-hidden={true} />
        </button>
      {/if}
      {#if mode === 'ask'}
        <button
          type="button"
          class="sp-primary hp-send"
          disabled={!query || asking || !canAsk}
          onclick={() => handlePromiseError(ask(query))}
        >
          {$t('frameleaf_help_panel_ask_button')}
          <Icon icon={mdiArrowUp} size="16" aria-hidden={true} />
        </button>
      {/if}
    </div>

    <div class="sp-bar">
      <div class="sp-scope" role="radiogroup" aria-label={$t('frameleaf_help_panel_mode')}>
        {#each [{ value: 'help' as const, label: $t('frameleaf_help_panel_articles'), icon: mdiBookOpenOutline }, { value: 'ask' as const, label: $t('frameleaf_help_panel_ask'), icon: mdiCreation }] as option (option.value)}
          <button
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            onclick={() => {
              mode = option.value;
              reading = null;
              active = -1;
              input?.focus();
            }}
          >
            <Icon icon={option.icon} size="14" aria-hidden={true} />
            {option.label}
          </button>
        {/each}
      </div>
      <span class="hp-context">
        <Icon icon={mdiMapMarkerOutline} size="14" aria-hidden={true} />
        {screenName}
      </span>
      <span class="sp-status" aria-live="polite">
        {#if mode === 'ask'}
          {asking ? $t('frameleaf_help_panel_finding') : ''}
        {:else if index}
          {$t('frameleaf_help_panel_count', { values: { count: query ? hits.length : index.articles.length } })}
        {/if}
      </span>
    </div>

    {#if index?.offline}
      <p class="hp-notice" role="status">
        <Icon icon={mdiWifiOff} size="16" aria-hidden={true} />
        <span>{$t('frameleaf_help_panel_offline')}</span>
      </p>
    {/if}

    <div class="sp-body">
      <div class="sp-results" id="hp-results" role="listbox" aria-label={$t('frameleaf_help_panel_title')}>
        {#if !index}
          <p class="sp-empty">
            {loadFailed ? $t('frameleaf_help_panel_load_failed') : $t('frameleaf_help_panel_loading')}
          </p>
        {:else if reading}
          <article class="hp-reader" bind:this={readerTop}>
            <button type="button" class="sp-link hp-back" onclick={back}>
              <Icon icon={mdiArrowLeft} size="14" aria-hidden={true} />
              {$t('frameleaf_help_panel_back')}
            </button>
            <p class="hp-eyebrow">{reading.article.sectionTitle}</p>
            <h2>{reading.article.title}</h2>
            <p class="hp-lede">{reading.article.description}</p>
            {#if reading.html}
              <div class="hp-markdown" bind:this={readerBody} onclick={onReaderClick} role="presentation">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by renderHelpArticle (DOMPurify) -->
                {@html reading.html}
              </div>
            {:else if reading.failed}
              <!-- offline: the opening of each section, from the saved index -->
              <div class="hp-markdown" bind:this={readerBody}>
                <p>{reading.article.intro}</p>
                {#each reading.article.headings as heading (heading.title)}
                  <h3 id={headingAnchor(heading.title)}>{heading.title}</h3>
                  <p>{heading.text}</p>
                {/each}
                <p class="hp-source">{$t('frameleaf_help_panel_article_failed')}</p>
              </div>
            {:else}
              <p class="sp-empty">{$t('frameleaf_help_panel_loading')}</p>
            {/if}
          </article>
        {:else if mode === 'ask'}
          {#if !canAsk && turns.length === 0}
            <p class="sp-empty hp-unavailable">
              <Icon icon={index.offline ? mdiWifiOff : mdiCreation} size="16" aria-hidden={true} />
              {index.offline ? $t('frameleaf_help_panel_ask_offline') : $t('frameleaf_help_panel_ask_off')}
            </p>
          {:else if turns.length === 0}
            <section>
              <h3>{$t('frameleaf_help_panel_try_asking')}</h3>
              {#each STARTERS as key (key)}
                {@render promptRow(key, $t(key), mdiLightbulbOnOutline)}
              {/each}
            </section>
          {:else}
            <div class="hp-conversation" aria-live="polite">
              {#each turns as turn, at (at)}
                {#if turn.role === 'user'}
                  <p class="hp-question">{turn.text}</p>
                {:else}
                  {@const numbers = new Map(turn.result.sources.map((source, position) => [source.id, position + 1]))}
                  <div class="hp-answer" class:fallback={turn.result.kind === 'fallback'}>
                    {#each turn.result.blocks as block, position (position)}
                      <p>
                        {block.text}
                        {#each block.sourceIds as id (id)}
                          {@const source = turn.result.sources.find((item) => item.id === id)}
                          {@const target = source && sourceTarget(source.url)}
                          <sup>
                            <button
                              type="button"
                              aria-label={$t('frameleaf_help_panel_source', { values: { number: numbers.get(id) } })}
                              disabled={!target}
                              onclick={() => target && handlePromiseError(open(target.item, target.anchor))}
                              >{numbers.get(id)}</button
                            >
                          </sup>
                        {/each}
                      </p>
                    {/each}
                    {#if turn.result.questions.length > 0}
                      <p class="hp-small">{$t('frameleaf_help_panel_more_detail')}</p>
                      <ul class="hp-questions">
                        {#each turn.result.questions as question (question)}
                          <li>{question}</li>
                        {/each}
                      </ul>
                    {/if}
                    {#if turn.result.sources.length > 0}
                      <ol class="hp-sources" aria-label={$t('frameleaf_help_panel_sources')}>
                        {#each turn.result.sources as source (source.id)}
                          {@const target = sourceTarget(source.url)}
                          <li>
                            {#if target}
                              <button
                                type="button"
                                onclick={() => handlePromiseError(open(target.item, target.anchor))}
                              >
                                <Icon icon={mdiFileDocumentOutline} size="14" aria-hidden={true} />
                                {source.title}
                              </button>
                            {:else}
                              <a href="{index.origin}{source.url}" target="_blank" rel="noreferrer">{source.title}</a>
                            {/if}
                          </li>
                        {/each}
                      </ol>
                    {/if}
                  </div>
                {/if}
              {/each}
              {#if asking}
                <p class="hp-thinking">
                  <span class="hp-dots" aria-hidden="true"></span>
                  {$t('frameleaf_help_panel_reading')}
                  <button type="button" class="sp-link" onclick={stop}>
                    <Icon icon={mdiStop} size="14" aria-hidden={true} />
                    {$t('frameleaf_help_panel_stop')}
                  </button>
                </p>
              {/if}
              {#if askProblem}
                <p class="sp-empty" role="alert">{askProblem}</p>
              {/if}
            </div>
          {/if}
        {:else if query}
          <section>
            <h3>{$t('frameleaf_help_panel_articles')}</h3>
            {#each hits as hit (hit.article.id)}
              {@render articleRow(hit.article, hit.heading?.title ?? null, hit.article.sectionTitle)}
            {:else}
              <p class="sp-empty">{$t('frameleaf_help_panel_no_match', { values: { query } })}</p>
            {/each}
          </section>
          {#if canAsk}
            <section>
              <h3>{$t('frameleaf_help_panel_ask')}</h3>
              {@render promptRow('ask', $t('frameleaf_help_panel_ask_query', { values: { query } }), mdiCreation, '⌘⏎')}
            </section>
          {/if}
        {:else if topic}
          <section>
            <h3>
              {sections.find(([id]) => id === topic)?.[1]}
              <button type="button" class="sp-link" onclick={back}>{$t('frameleaf_help_panel_all_topics')}</button>
            </h3>
            {#each topicArticles as item (item.id)}
              {@render articleRow(item, null, null)}
            {/each}
          </section>
        {:else}
          <section>
            <h3>{$t('frameleaf_help_panel_for_screen', { values: { screen: screenName } })}</h3>
            {#each forScreen as item (item.id)}
              {@render articleRow(item, null, null)}
            {/each}
          </section>
          {#if canAsk}
            <section>
              <h3>{$t('frameleaf_help_panel_ask')}</h3>
              {#each STARTERS.slice(0, 3) as key (key)}
                {@render promptRow(key, $t(key), mdiCreation)}
              {/each}
            </section>
          {/if}
          <section>
            <h3>{$t('frameleaf_help_panel_topics')}</h3>
            <div class="hp-topics">
              {#each sections as [id, title] (id)}
                <button type="button" onclick={() => (topic = id)}>{title}</button>
              {/each}
            </div>
          </section>
        {/if}
      </div>

      <aside
        class="sp-side hp-side"
        aria-label={$t('frameleaf_help_panel_on_this_page')}
        data-view={reading ? 'reader' : mode === 'ask' ? 'about' : 'preview'}
      >
        {#if index && reading}
          <section class="hp-preview">
            <h3>{$t('frameleaf_help_panel_on_this_page')}</h3>
            <ul class="hp-toc">
              {#each reading.article.headings as heading (heading.title)}
                {@const anchor = headingAnchor(heading.title)}
                <li>
                  <button
                    type="button"
                    aria-current={reading.heading === anchor ? 'true' : undefined}
                    onclick={() => {
                      reading!.heading = anchor;
                      handlePromiseError(scrollToHeading(anchor));
                    }}>{heading.title}</button
                  >
                </li>
              {/each}
            </ul>
            <div class="hp-actions">
              <a
                class="sp-secondary"
                href="{index.origin}{reading.article.url}{reading.heading ? `#${reading.heading}` : ''}"
                target="_blank"
                rel="noreferrer"
              >
                {$t('frameleaf_help_panel_open_website')}
                <Icon icon={mdiOpenInNew} size="14" aria-hidden={true} />
              </a>
              {#if canAsk}
                <button
                  type="button"
                  class="sp-secondary"
                  onclick={() => {
                    mode = 'ask';
                    text = $t('frameleaf_help_panel_ask_about_prefix', { values: { title: reading!.article.title } });
                    reading = null;
                    input?.focus();
                  }}
                >
                  <Icon icon={mdiCreation} size="14" aria-hidden={true} />
                  {$t('frameleaf_help_panel_ask_about_page')}
                </button>
              {/if}
            </div>
          </section>
        {:else if index && mode === 'ask'}
          <section class="hp-preview">
            <p class="hp-eyebrow">{$t('frameleaf_help_panel_ask')}</p>
            <h2>{$t('frameleaf_help_panel_about_title')}</h2>
            <p>{$t('frameleaf_help_panel_about_text')}</p>
            <p class="hp-small">{$t('frameleaf_help_panel_about_sent')}</p>
            {#if index.ask.hardware && canAsk}
              <p class="hp-hardware">
                <Icon icon={mdiExpansionCardVariant} size="16" aria-hidden={true} />
                <span>
                  <strong>{$t('frameleaf_help_panel_fits_server')}</strong>
                  <small>{index.ask.hardware}</small>
                </span>
              </p>
            {/if}
            {#if canAsk}
              <p class="hp-small">{$t('frameleaf_help_panel_admin_can_turn_off')}</p>
            {/if}
          </section>
        {:else if index && preview}
          <section class="hp-preview">
            <p class="hp-eyebrow">{preview.sectionTitle}</p>
            <h2>{preview.title}</h2>
            <p>{preview.description}</p>
            {#if preview.headings.length > 0}
              <h3>{$t('frameleaf_help_panel_on_this_page')}</h3>
              <ul class="hp-toc">
                {#each preview.headings.slice(0, 6) as heading (heading.title)}
                  <li>
                    <button
                      type="button"
                      onclick={() => handlePromiseError(open(preview, headingAnchor(heading.title)))}
                      >{heading.title}</button
                    >
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="hp-actions">
              <button type="button" class="sp-primary" onclick={() => handlePromiseError(open(preview))}>
                {$t('frameleaf_help_panel_read')}
              </button>
              <a class="sp-secondary" href={helpArticleUrl(index.origin, preview)} target="_blank" rel="noreferrer">
                {site}
                <Icon icon={mdiOpenInNew} size="14" aria-hidden={true} />
              </a>
            </div>
          </section>
        {/if}
      </aside>
    </div>

    <footer class="sp-footer">
      <span class="sp-keys" aria-hidden="true">
        <kbd>↑</kbd><kbd>↓</kbd>
        {$t('frameleaf_help_panel_key_move')}
        <kbd>⏎</kbd>
        {$t('frameleaf_help_panel_key_open')}
        <kbd>⌘⏎</kbd>
        {$t('frameleaf_help_panel_key_ask')}
        <kbd>esc</kbd>
        {reading || topic ? $t('frameleaf_help_panel_key_back') : $t('frameleaf_help_panel_key_close')}
      </span>
      <span class="sp-note">
        {#if index}
          <a href="{index.origin}/help/" target="_blank" rel="noreferrer"
            >{updated
              ? $t('frameleaf_help_panel_from', { values: { site: `${site}/help`, date: updated } })
              : $t('frameleaf_help_panel_from_bundled', { values: { site: `${site}/help` } })}</a
          >
        {/if}
      </span>
      {#if mode === 'ask' && turns.length > 0}
        <button
          type="button"
          class="sp-secondary"
          onclick={() => {
            askController?.abort();
            asking = false;
            turns = [];
            askProblem = null;
            input?.focus();
          }}
        >
          <Icon icon={mdiRefresh} size="16" aria-hidden={true} />
          {$t('frameleaf_help_panel_new_conversation')}
        </button>
      {/if}
      <button
        type="button"
        class="sp-secondary"
        onclick={() => {
          onClose();
          handlePromiseError(openSupportDialog());
        }}
      >
        <Icon icon={mdiLifebuoy} size="16" aria-hidden={true} />
        {$t('frameleaf_help_panel_support')}
      </button>
    </footer>
  </form>
</dialog>

<style>
  /* The search palette's glass panel (SearchPalette.svelte, search-palette.css), with a reader and Ask
     Frameleaf in the body (help-palette.css in the prototype). */
  .search-palette {
    --sp-glass: color-mix(in srgb, var(--fl-panel) 74%, transparent);
    --sp-edge: color-mix(in srgb, var(--fl-text) 14%, transparent);
    --sp-row: color-mix(in srgb, var(--fl-text) 8%, transparent);
    --sp-active: color-mix(in srgb, var(--fl-accent) 22%, transparent);
    width: min(980px, calc(100vw - 32px));
    max-width: none;
    max-height: min(760px, calc(100dvh - 12vh - 24px));
    margin: 10vh auto auto;
    padding: 0;
    overflow: hidden;
    color: var(--fl-text);
    background: var(--sp-glass);
    backdrop-filter: blur(40px) saturate(180%);
    border: 1px solid var(--sp-edge);
    border-radius: 20px;
    box-shadow:
      0 30px 120px #000a,
      inset 0 1px 0 #ffffff14;
    font-size: 13px;
    animation: sp-in var(--fl-duration-dock) var(--fl-spring) both;
  }
  @keyframes sp-in {
    from {
      opacity: 0;
      scale: 0.97;
    }
    to {
      opacity: 1;
      scale: 1;
    }
  }
  @keyframes sp-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .search-palette.reduced-motion {
    animation: sp-fade var(--fl-duration-reduced) var(--fl-ease) both;
  }
  @media (prefers-reduced-motion: reduce) {
    .search-palette {
      animation: sp-fade var(--fl-duration-reduced) var(--fl-ease) both !important;
    }
  }
  .search-palette::backdrop {
    background: #0005;
    backdrop-filter: blur(10px);
  }
  @supports (corner-shape: squircle) {
    .search-palette {
      border-radius: 36px;
    }
  }
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .search-palette {
      --sp-glass: var(--fl-panel);
      backdrop-filter: none;
    }
    .search-palette::backdrop {
      background: rgb(0 0 0 / 67%);
      backdrop-filter: none;
    }
  }
  .search-palette form {
    display: flex;
    flex-direction: column;
    max-height: inherit;
  }
  .search-palette button {
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .search-palette h3 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 var(--fl-space-2);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  .search-palette kbd {
    display: inline-grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 5px;
    background: var(--sp-row);
    border: 1px solid var(--sp-edge);
    font-size: 11px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .search-palette small {
    color: var(--fl-muted);
  }
  .sp-field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 14px 12px 18px;
    border-bottom: 1px solid var(--sp-edge);
    color: var(--fl-muted);
  }
  .sp-tokens {
    flex: 1;
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .sp-tokens input {
    flex: 1;
    min-width: 180px;
    padding: 6px 0;
    border: 0;
    border-radius: 0;
    outline: 0;
    box-shadow: none;
    background: transparent;
    color: var(--fl-text);
    font-size: 21px;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .sp-icon-button {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 8px;
    background: transparent;
  }
  .sp-icon-button:hover {
    background: var(--sp-row);
  }
  .sp-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 14px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--sp-edge);
  }
  .sp-scope {
    display: inline-flex;
    padding: 2px;
    border-radius: var(--fl-radius-control-compact);
    background: var(--sp-row);
  }
  .sp-scope button {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 4px 12px;
    border: 0;
    border-radius: calc(var(--fl-radius-control-compact) - 2px);
    background: transparent;
    color: var(--fl-muted);
  }
  .sp-scope button[aria-checked='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-1);
  }
  .sp-status {
    margin-inline-start: auto;
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .sp-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    min-height: 0;
    flex: 1;
    animation: sp-fade var(--fl-motion) var(--fl-ease) both;
  }
  .sp-results,
  .sp-side {
    overflow: auto;
    padding: 14px 18px;
    display: grid;
    align-content: start;
    gap: 18px;
  }
  .sp-side {
    border-inline-start: 1px solid var(--sp-edge);
    background: color-mix(in srgb, var(--fl-canvas) 30%, transparent);
  }
  .sp-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 6px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  .sp-row > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sp-row.active {
    background: var(--sp-active);
  }
  .sp-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: transparent;
    color: var(--fl-accent) !important;
    font-size: 12px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
  }
  .sp-empty {
    margin: 0;
    color: var(--fl-muted);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .sp-footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 10px 18px;
    border-top: 1px solid var(--sp-edge);
  }
  .sp-keys {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--fl-muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .sp-note {
    flex: 1;
    color: var(--fl-muted);
    font-size: 11px;
    text-align: end;
  }
  .sp-note a {
    color: inherit;
  }
  .sp-secondary,
  .sp-primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 14px;
    border-radius: 10px;
    font-weight: 600;
    white-space: nowrap;
    text-decoration: none;
  }
  .sp-secondary {
    border: 1px solid var(--sp-edge);
    background: transparent;
    color: inherit;
  }
  .sp-primary {
    border: 0;
    background: var(--fl-accent);
    color: var(--fl-accent-text) !important;
  }
  .sp-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* help */
  .hp-send {
    height: 32px;
  }
  .hp-context {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fl-muted);
  }
  .hp-notice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 0;
    padding: 10px 18px;
    border-bottom: 1px solid var(--sp-edge);
    background: color-mix(in srgb, var(--fl-warning, #ff9f0a) 14%, transparent);
  }
  .hp-notice > :global(svg) {
    flex: none;
    margin-top: 1px;
    color: var(--fl-warning, #ff9f0a);
  }
  .sp-row > .hp-two {
    display: grid;
    gap: 1px;
    white-space: normal;
  }
  .hp-two strong,
  .hp-two small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hp-two strong {
    font-weight: 500;
  }
  .hp-heading {
    font-style: normal;
    color: var(--fl-muted);
  }
  .hp-section {
    max-width: 30%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hp-topics {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .hp-topics button {
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--sp-edge);
    border-radius: 9px;
    background: transparent;
  }
  .hp-topics button:hover {
    background: var(--sp-row);
  }
  .hp-preview {
    display: grid;
    gap: 10px;
    align-content: start;
  }
  .hp-preview h2,
  .hp-reader h2 {
    margin: 0;
    font-size: 17px;
    line-height: 1.3;
    letter-spacing: -0.01em;
  }
  .hp-preview p {
    margin: 0;
    line-height: 1.5;
  }
  .hp-preview h3 {
    margin-top: var(--fl-space-2);
  }
  .hp-eyebrow {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fl-accent);
  }
  .hp-toc {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .hp-toc button {
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    text-align: start;
    color: var(--fl-muted) !important;
  }
  .hp-toc button:hover,
  .hp-toc button[aria-current='true'] {
    background: var(--sp-row);
    color: var(--fl-text) !important;
  }
  .hp-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: var(--fl-space-2);
  }
  .hp-small {
    color: var(--fl-muted);
    font-size: 12px;
  }
  .hp-hardware {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    border: 1px solid var(--sp-edge);
    border-radius: 10px;
  }
  .hp-hardware > :global(svg) {
    flex: none;
    margin-top: 1px;
    color: var(--fl-muted);
  }
  .hp-hardware span {
    display: grid;
    gap: 2px;
  }
  .hp-hardware strong {
    font-weight: 500;
  }

  /* reader */
  .hp-reader {
    display: grid;
    gap: 12px;
    /* a long code line or a wide table scrolls inside itself, never the panel */
    min-width: 0;
    max-width: 68ch;
    line-height: 1.6;
    font-size: 14px;
  }
  .hp-reader > p {
    margin: 0;
  }
  .hp-back {
    justify-self: start;
    padding: 0;
  }
  .hp-lede {
    font-size: 15px;
    color: var(--fl-muted);
  }
  .hp-markdown {
    min-width: 0;
  }
  .hp-markdown :global(:is(p, ul, ol, table, pre)) {
    margin: 0 0 12px;
  }
  .hp-markdown :global(:is(table, pre)) {
    max-width: 100%;
  }
  .hp-markdown :global(:is(h2, h3)) {
    margin: 18px 0 6px;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    color: var(--fl-text);
    scroll-margin-top: 14px;
  }
  .hp-markdown :global(:is(ul, ol)) {
    padding-inline-start: 20px;
  }
  .hp-markdown :global(ul) {
    list-style: disc;
  }
  .hp-markdown :global(ol) {
    list-style: decimal;
  }
  .hp-markdown :global(li + li) {
    margin-top: 4px;
  }
  .hp-markdown :global(a) {
    color: var(--fl-accent);
  }
  .hp-markdown :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 10px;
  }
  .hp-markdown :global(code) {
    font:
      12px ui-monospace,
      SFMono-Regular,
      monospace;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--sp-row);
  }
  .hp-markdown :global(pre) {
    overflow: auto;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--sp-row);
  }
  .hp-markdown :global(pre code) {
    padding: 0;
    background: none;
  }
  .hp-markdown :global(table) {
    display: block;
    overflow: auto;
    border-collapse: collapse;
    font-size: 13px;
  }
  .hp-markdown :global(:is(th, td)) {
    padding: 6px 10px;
    border: 1px solid var(--sp-edge);
    text-align: start;
    vertical-align: top;
  }
  .hp-markdown :global(aside) {
    margin: 0 0 12px;
    padding: 10px 14px;
    border-inline-start: 3px solid var(--fl-accent);
    border-radius: 8px;
    background: var(--sp-row);
  }
  .hp-markdown :global(aside[data-kind='caution']),
  .hp-markdown :global(aside[data-kind='danger']) {
    border-inline-start-color: var(--fl-warning, #ff9f0a);
  }
  .hp-markdown :global(aside > :last-child) {
    margin-bottom: 0;
  }
  .hp-source {
    padding-top: 12px;
    border-top: 1px solid var(--sp-edge);
    font-size: 12px;
    color: var(--fl-muted);
  }

  /* Ask Frameleaf */
  .hp-conversation {
    display: grid;
    gap: 14px;
    line-height: 1.55;
    font-size: 14px;
  }
  .hp-question {
    justify-self: end;
    max-width: 80%;
    margin: 0;
    padding: 8px 12px;
    border-radius: 14px 14px 4px 14px;
    background: var(--sp-active);
  }
  .hp-answer {
    display: grid;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--sp-edge);
    border-radius: 14px;
    background: var(--sp-row);
  }
  .hp-answer p {
    margin: 0;
  }
  .hp-answer.fallback p {
    color: var(--fl-muted);
  }
  .hp-answer sup button {
    min-width: 16px;
    height: 16px;
    margin-inline-start: 2px;
    padding: 0 4px;
    border: 0;
    border-radius: 5px;
    background: var(--sp-active);
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
  }
  .hp-questions {
    margin: 0;
    padding-inline-start: 20px;
  }
  .hp-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
    counter-reset: source;
  }
  .hp-sources li {
    counter-increment: source;
  }
  .hp-sources :is(button, a) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--sp-edge);
    border-radius: 8px;
    background: transparent;
    font-size: 12px;
    color: inherit;
    text-decoration: none;
  }
  .hp-sources :is(button, a)::before {
    content: counter(source);
    font-weight: 600;
    color: var(--fl-muted);
  }
  .hp-thinking {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    color: var(--fl-muted);
  }
  .hp-dots {
    width: 28px;
    height: 8px;
    background: radial-gradient(circle closest-side, currentColor 90%, transparent) 0 / 33% 100% space;
    animation: hp-pulse 1s ease-in-out infinite alternate;
  }
  @keyframes hp-pulse {
    to {
      opacity: 0.3;
    }
  }
  .reduced-motion .hp-dots {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .hp-dots {
      animation: none;
    }
  }

  @media (max-width: 760px) {
    .search-palette {
      width: calc(100vw - 16px);
      margin-top: max(8px, env(safe-area-inset-top));
      max-height: calc(100dvh - 16px);
    }
    .sp-body {
      grid-template-columns: 1fr;
    }
    .sp-keys,
    .sp-note,
    .hp-context,
    .hp-section,
    .hp-side:not([data-view='reader']) {
      display: none;
    }
    .hp-side {
      border-inline-start: 0;
      border-top: 1px solid var(--sp-edge);
    }
    .sp-tokens input {
      font-size: 17px;
      min-width: 120px;
    }
  }
</style>
