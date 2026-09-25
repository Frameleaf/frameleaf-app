<script lang="ts">
  /**
   * The activated supporter key (AuthScreens.jsx:1880-1931, effd05ffb7): "Thank you", the key's kind
   * and last four symbols, when it was activated, the badge, "Hide the supporter badge" (on hides
   * it) and "Remove key" with an in-place confirmation. `onRemove` is absent when this person may
   * not remove the key (a server key seen by someone who is not an administrator).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import { Icon } from '@immich/ui';
  import { mdiHandHeartOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    name: string;
    kind: 'server' | 'individual';
    keyHint: string | null;
    activatedAt: string | Date | null;
    badgeHidden: boolean;
    busy?: boolean;
    onBadgeHidden: (hidden: boolean) => void;
    onRemove?: () => void;
  };

  let { name, kind, keyHint, activatedAt, badgeHidden, busy = false, onBadgeHidden, onRemove }: Props = $props();
  let confirmRemove = $state(false);
  const titleId = $props.id();

  const activated = $derived(
    activatedAt
      ? new Date(activatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
      : '—',
  );
</script>

<section class="auth-card fl-continuous-corners" aria-labelledby={titleId}>
  <div class="buy-active">
    <span class="buy-badge"><Icon icon={mdiHandHeartOutline} size="28" /></span>
    <div>
      <h3 id={titleId}>
        {name ? $t('frameleaf_buy_thank_you_name', { values: { name } }) : $t('frameleaf_buy_thank_you')}
      </h3>
      <dl>
        <dt>{$t('frameleaf_buy_key_term')}</dt>
        <dd>
          {kind === 'server'
            ? $t('frameleaf_buy_supporter_server_title')
            : $t('frameleaf_buy_supporter_individual_title')}
          {#if keyHint}
            · {$t('frameleaf_buy_key_ends_in', { values: { hint: keyHint } })}
          {/if}
        </dd>
        <dt>{$t('frameleaf_license_activated')}</dt>
        <dd>{activated}</dd>
        <dt>{$t('frameleaf_buy_badge_term')}</dt>
        <dd>
          <span class="supporter-badge"><Icon icon={mdiHandHeartOutline} size="12" />{$t('supporter')}</span>
        </dd>
      </dl>
    </div>
  </div>
  <div class="buy-switch-row">
    <div>
      <strong>{$t('frameleaf_buy_hide_badge')}</strong>
      <p id="{titleId}-hide">{$t('frameleaf_buy_hide_badge_help')}</p>
    </div>
    <Toggle
      label={$t('frameleaf_buy_hide_badge')}
      checked={badgeHidden}
      describedBy="{titleId}-hide"
      onLabel={$t('frameleaf_cloud_toggle_on')}
      offLabel={$t('frameleaf_cloud_toggle_off')}
      onChange={onBadgeHidden}
    />
  </div>
  {#if onRemove}
    <div class="auth-row">
      {#if confirmRemove}
        <span>
          {kind === 'server' ? $t('frameleaf_buy_remove_server_prompt') : $t('frameleaf_buy_remove_personal_prompt')}
        </span>
        <span class="buy-key-row">
          <Button onclick={() => (confirmRemove = false)}>{$t('frameleaf_buy_keep')}</Button>
          <Button
            variant="danger"
            disabled={busy}
            onclick={() => {
              confirmRemove = false;
              onRemove?.();
            }}
          >
            {$t('frameleaf_license_remove_confirm')}
          </Button>
        </span>
      {:else}
        <button type="button" class="auth-link" onclick={() => (confirmRemove = true)}>
          {$t('frameleaf_license_remove_confirm')}
        </button>
      {/if}
    </div>
  {/if}
</section>
