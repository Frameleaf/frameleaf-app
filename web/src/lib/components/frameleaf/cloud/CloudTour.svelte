<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  import { readingKey } from '$lib/frameleaf/reading-direction';
  /**
   * FL-196: the linked-server tour sheet, the owner-approved prototype's `CloudTour`
   * (design/frameleaf/template/src/CloudTour.jsx, c4a009f8b5). Six steps over Settings → Frameleaf
   * Cloud: each with an icon tile, a title, a summary, three points, an "On this server" chip from
   * the server's real state and "Open …" links to the real settings pages.
   *
   * Arrow keys and swipes move between steps, Escape skips, focus moves to each step's heading and
   * the step count is announced. Steps slide in with the spring from the direction of travel and
   * crossfade under Reduce Motion, which is checked here in JavaScript (Web Animations do not follow
   * the CSS reduced-motion rules). The sheet leaves the way every sheet does (`leave`, motion.ts)
   * before the caller hears about it. The caller decides what an ending does (`onClose`) and where
   * a link goes (`onOpen`); this component never calls the server.
   */
  import '$lib/frameleaf/tokens.css';
  import './frameleaf-cloud.css';
  import './cloud-tour.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { formatUsd } from '$lib/frameleaf/cloud-ml';
  import { discountPercent, formatUsd as formatPrice } from '$lib/frameleaf/cloud';
  import {
    clampTourStep,
    cloudTourStatus,
    cloudTourSteps,
    linkKey,
    pointKey,
    stepKey,
    type CloudTourChip,
    type CloudTourEnding,
    type CloudTourFacts,
    type CloudTourLink,
    type CloudTourStepId,
  } from '$lib/frameleaf/cloud-tour';
  import { leave } from '$lib/frameleaf/motion';
  import { DURATION, EASE } from '$lib/frameleaf/tokens';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { mdiCheckCircle, mdiChevronLeft, mdiChevronRight, mdiShimmer } from '@mdi/js';
  import { onMount, tick, untrack } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    facts: CloudTourFacts;
    /** The linked Frameleaf account, as the link status names it. */
    account?: string | null;
    /** The lowest monthly plan price and the licensed-server share, from the bundled or published prices. */
    planFromUsd?: number | null;
    licensedDiscount?: number | null;
    initialStep?: number;
    onClose: (ending: Exclude<CloudTourEnding, 'setup'>) => void;
    onOpen: (link: CloudTourLink) => void;
  };

  const {
    facts,
    account = null,
    planFromUsd = null,
    licensedDiscount = null,
    initialStep = 0,
    onClose,
    onOpen,
  }: Props = $props();

  let dialog: HTMLDialogElement;
  let body = $state<HTMLDivElement>();
  let heading = $state<HTMLHeadingElement>();
  let index = $state(untrack(() => clampTourStep(initialStep)));
  let direction = 1;
  let shown: number | null = null;
  const titleId = $props.id();
  const summaryId = `${titleId}-summary`;

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const step = $derived(cloudTourSteps[index]);
  const last = $derived(index === cloudTourSteps.length - 1);
  const chip = $derived(cloudTourStatus(step.id, facts));

  const go = (next: number) => {
    const target = clampTourStep(next);
    if (target === index) {
      return;
    }
    direction = target > index ? 1 : -1;
    index = target;
  };

  // Everything that opens also closes: the sheet and its scrim leave, then the caller is told.
  let cancelLeave: (() => void) | undefined;
  const end = (finish: () => void) => {
    cancelLeave?.();
    cancelLeave = leave(dialog, 'sheet', finish, { backdrop: true });
  };
  const close = (ending: Exclude<CloudTourEnding, 'setup'>) => end(() => onClose(ending));
  const open = (link: CloudTourLink) => end(() => onOpen(link));

  onMount(() => {
    const previous = document.activeElement;
    if (!dialog.open) {
      dialog.showModal();
    }
    dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      cancelLeave?.();
      if (dialog.open) {
        dialog.close();
      }
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  });

  // Web Animations need a literal easing, so read the shared spring token (a `linear()` curve).
  const spring = (node: Element) => getComputedStyle(node).getPropertyValue('--fl-spring').trim() || EASE;

  // Slide in from the direction of travel; a plain crossfade under Reduce Motion.
  $effect(() => {
    const current = index;
    const previous = shown;
    shown = current;
    if (previous === null || previous === current || !body) {
      return;
    }
    const node = body;
    let run: Animation | undefined;
    let tile: Animation | undefined;
    void tick().then(() => {
      heading?.focus({ preventScroll: true });
      const reduced = mediaQueryManager.reducedMotion;
      const frames = reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: `translateX(${direction * 28}px)` },
            { opacity: 1, transform: 'none' },
          ];
      run = node.animate?.(frames, {
        duration: reduced ? DURATION.reduced : DURATION.sheet,
        easing: reduced ? EASE : spring(node),
        fill: 'both',
      });
      tile = reduced
        ? undefined
        : node.querySelector('.ct-tile')?.animate?.([{ transform: 'scale(0.82)' }, { transform: 'none' }], {
            duration: DURATION.hero,
            easing: spring(node),
          });
    });
    return () => {
      run?.cancel();
      tile?.cancel();
    };
  });

  /** Swipes turn pages on touch and pen; a mostly vertical drag scrolls the step instead. */
  const swipeable = (node: HTMLElement) => {
    let start: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      start = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY };
    };
    const up = (event: PointerEvent) => {
      const from = start;
      start = null;
      if (!from) {
        return;
      }
      const dx = event.clientX - from.x;
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(event.clientY - from.y) * 1.5) {
        go(index + (dx < 0 ? 1 : -1));
      }
    };
    const cancel = () => (start = null);
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', cancel);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
    };
  };

  const keydown = (event: KeyboardEvent) => {
    if ((event.target as Element | null)?.closest?.('input, select, textarea')) {
      return;
    }
    const key = readingKey(event.key);
    if (key === 'ArrowRight') {
      event.preventDefault();
      go(index + 1);
    } else if (key === 'ArrowLeft') {
      event.preventDefault();
      go(index - 1);
    }
  };

  const chipLabel = (value: CloudTourChip) => {
    switch (value.kind) {
      case 'text': {
        return $t(value.key);
      }
      case 'credit': {
        return $t(value.on ? 'frameleaf_cloud_tour_status_credit_on' : 'frameleaf_cloud_tour_status_credit_off', {
          values: { amount: formatUsd(value.usd) },
        });
      }
      case 'plan': {
        const plan = {
          none: () => $t('frameleaf_plan_status_none'),
          active: () => $t('frameleaf_license_state_active'),
          grace: () =>
            $t('frameleaf_plan_status_grace', {
              values: {
                date: value.graceUntil
                  ? new Intl.DateTimeFormat($locale, { dateStyle: 'long' }).format(new Date(value.graceUntil))
                  : '—',
              },
            }),
          expired: () => $t('frameleaf_license_state_expired'),
          invalid: () => $t('frameleaf_license_state_invalid'),
        }[value.state]();
        return value.licensed ? $t('frameleaf_cloud_tour_status_licensed', { values: { plan } }) : plan;
      }
    }
  };

  const pointText = (id: CloudTourStepId, point: string) => {
    if (id === 'plan' && point === 'plan') {
      return planFromUsd === null
        ? $t('frameleaf_cloud_tour_plan_plan_text_no_price')
        : $t(pointKey(id, point, 'text'), { values: { price: formatPrice(planFromUsd) } });
    }
    if (id === 'plan' && point === 'license') {
      return licensedDiscount
        ? $t(pointKey(id, point, 'text'), { values: { pct: discountPercent(licensedDiscount) } })
        : $t('frameleaf_cloud_tour_plan_license_text_no_discount');
    }
    return $t(pointKey(id, point, 'text'));
  };
</script>

<dialog
  bind:this={dialog}
  class="frameleaf dialog cloud-tour fl-continuous-corners"
  data-theme={appTheme}
  data-step={step.id}
  aria-labelledby={titleId}
  aria-describedby={summaryId}
  onkeydown={keydown}
  oncancel={(event) => {
    event.preventDefault();
    close('skipped');
  }}
>
  <p class="ct-overline" aria-live="polite">
    <span>{$t('frameleaf_cloud_tour_overline')}</span>
    <span aria-hidden="true">·</span>
    <span>{$t('frameleaf_cloud_tour_count', { values: { current: index + 1, total: cloudTourSteps.length } })}</span>
  </p>

  <div class="ct-body" bind:this={body} {@attach swipeable}>
    {#if index === 0}
      <p class="ct-linked">
        <Icon icon={mdiCheckCircle} size="16" aria-hidden />
        <span>
          {#if account}
            <FormatMessage key="frameleaf_cloud_tour_linked_to" values={{ account }}>
              {#snippet children({ message })}<strong>{message}</strong>{/snippet}
            </FormatMessage>
          {:else}
            {$t('frameleaf_cloud_tour_linked')}
          {/if}
        </span>
      </p>
    {/if}
    <div class="ct-head">
      <span class="ct-tile" data-tone={step.tile} aria-hidden="true">
        <Icon icon={step.icon} size="30" aria-hidden />
        {#if step.ai}
          <span class="ct-ai"><Icon icon={mdiShimmer} size="12" aria-hidden /></span>
        {/if}
      </span>
      <h2 id={titleId} bind:this={heading} tabindex="-1">{$t(stepKey(step.id, 'title'))}</h2>
      <p id={summaryId}>{$t(stepKey(step.id, 'summary'))}</p>
    </div>

    <ul class="ct-points">
      {#each step.points as point (point.id)}
        <li>
          <Icon icon={point.icon} size="20" aria-hidden />
          <span>
            <strong>{$t(pointKey(step.id, point.id, 'title'))}</strong>
            <small>{pointText(step.id, point.id)}</small>
          </span>
        </li>
      {/each}
    </ul>

    <div class="ct-where">
      <p class="ct-status">
        <span>{$t('frameleaf_cloud_tour_on_this_server')}</span>
        <span
          class="fc-status"
          class:is-ok={chip.tone === 'ok'}
          class:is-warning={chip.tone === 'warning'}
          data-testid="cloud-tour-status">{chipLabel(chip)}</span
        >
      </p>
      <div class="ct-links">
        {#each step.links as link (link.id)}
          <button type="button" class="ct-link" onclick={() => open(link)}>
            {$t(linkKey(link.id) as Translations)}
            <Icon icon={mdiChevronRight} size="16" aria-hidden />
          </button>
        {/each}
      </div>
    </div>
  </div>

  <footer class="ct-footer">
    <div class="ct-dots" role="group" aria-label={$t('frameleaf_cloud_tour_steps')}>
      {#each cloudTourSteps as item, position (item.id)}
        <button
          type="button"
          aria-label={$t('frameleaf_cloud_tour_step_label', {
            values: { number: position + 1, title: $t(stepKey(item.id, 'title')) },
          })}
          aria-current={position === index ? 'step' : undefined}
          onclick={() => go(position)}
        ></button>
      {/each}
    </div>
    <div class="ct-actions">
      {#if !last}
        <button type="button" class="ct-skip" onclick={() => close('skipped')}>{$t('frameleaf_cloud_tour_skip')}</button
        >
      {/if}
      <span class="ct-spacer"></span>
      {#if index > 0}
        <span class="ct-back">
          <Button label={$t('frameleaf_cloud_tour_back')} onclick={() => go(index - 1)}>
            <Icon icon={mdiChevronLeft} size="18" aria-hidden />
          </Button>
        </span>
      {/if}
      <span class="ct-next">
        <Button variant="primary" initialFocus onclick={() => (last ? close('finished') : go(index + 1))}>
          {last ? $t('frameleaf_cloud_tour_done') : $t('frameleaf_cloud_tour_next')}
        </Button>
      </span>
    </div>
  </footer>
</dialog>
