<script lang="ts">
  import FrameleafErrorPage from '$lib/components/frameleaf/FrameleafErrorPage.svelte';
  import { ERROR_COPY, errorKind, errorStatus, type ErrorPageAction } from '$lib/frameleaf/error-page';
  import { Route } from '$lib/route';
  import { mdiAlertCircleOutline, mdiImageOffOutline, mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The app-wide error page (FL-55): every route without an error page of its own, and a server the
   * app could not reach at start-up, land here.
   *
   * It explains the failure as one of three things a person can act on — not found, no access, or
   * a problem on our side — with the ways on. What the server said, and any stack trace, stay in the
   * console and the logs; they are never shown to the person using Frameleaf.
   */
  interface Props {
    /** The SvelteKit error, or the start-up failure the root layout caught. */
    error?: unknown;
    /** SvelteKit's status for the page, when there is one. */
    status?: number;
  }

  let { error = undefined, status = undefined }: Props = $props();

  const code = $derived(errorStatus(status, error));
  const kind = $derived(errorKind(code));
  const copy = $derived(ERROR_COPY[kind]);
  const icon = $derived(
    kind === 'not-found' ? mdiImageOffOutline : kind === 'forbidden' ? mdiLockOutline : mdiAlertCircleOutline,
  );

  const canGoBack = typeof history !== 'undefined' && history.length > 1;

  const actions = $derived.by(() => {
    const list: ErrorPageAction[] = [{ label: $t('frameleaf_error_go_photos'), href: Route.photos(), primary: true }];
    if (kind === 'server') {
      list.push({ label: $t('frameleaf_error_retry'), onclick: () => location.reload() });
    }
    if (canGoBack) {
      list.push({ label: $t('frameleaf_error_go_back'), onclick: () => history.back() });
    }
    return list;
  });
</script>

<FrameleafErrorPage standalone title={$t(copy.title)} message={$t(copy.body)} {code} {icon} {actions} />
