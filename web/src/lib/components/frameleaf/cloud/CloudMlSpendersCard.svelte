<script lang="ts">
  /**
   * Who may spend the AI Wallet (FL-162 owner decision, 2026-09-26). Administrators always may; an
   * administrator allows anyone else here, each with an optional monthly limit in USD (settled charges
   * plus the holds of their running jobs). The server enforces it when a job is confirmed, whatever a
   * page shows; people not on the list still see estimates. Saved with the Frameleaf Cloud settings
   * (`frameleafCloud.cloudMl.spenders`).
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { searchUsersAdmin, type UserAdminResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = { disabled?: boolean };

  let { disabled = false }: Props = $props();

  const settingsDraft = getSystemConfigDraft();
  const cloudMl = $derived(settingsDraft?.draft.frameleafCloud?.cloudMl);
  const baseline = $derived(settingsDraft?.baseline.frameleafCloud?.cloudMl);

  let users = $state<UserAdminResponseDto[]>([]);
  let chosen = $state('');

  onMount(async () => {
    try {
      users = await searchUsersAdmin({});
    } catch (error) {
      handleError(error, $t('admin.frameleaf_cloud_ml_spenders_load_error'));
    }
  });

  const spenders = $derived(cloudMl?.spenders ?? []);
  const edited = $derived(JSON.stringify(spenders) !== JSON.stringify(baseline?.spenders ?? []));
  /** People who can be allowed: not administrators (they always may), not removed, not listed yet. */
  const candidates = $derived(
    users
      .filter((user) => !user.isAdmin && !user.deletedAt && spenders.every((entry) => entry.userId !== user.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  const nameOf = (userId: string) => {
    const user = users.find((entry) => entry.id === userId);
    return user ? `${user.name} · ${user.email}` : $t('admin.frameleaf_cloud_ml_spenders_unknown');
  };

  const add = () => {
    if (!cloudMl || !chosen) {
      return;
    }
    cloudMl.spenders = [...spenders, { userId: chosen, monthlyCapUsd: null }];
    chosen = '';
  };

  const remove = (userId: string) => {
    if (cloudMl) {
      cloudMl.spenders = spenders.filter((entry) => entry.userId !== userId);
    }
  };

  /**
   * An empty limit is no limit; anything else is USD from 0 to 100,000. The field shows what is kept,
   * also when clamping leaves the stored value as it was (the page would not redraw it then).
   */
  const setCap = (userId: string, input: HTMLInputElement) => {
    if (!cloudMl) {
      return;
    }
    const amount = input.value.trim() === '' ? null : Number(input.value);
    const monthlyCapUsd = amount === null || !Number.isFinite(amount) ? null : Math.min(100_000, Math.max(0, amount));
    cloudMl.spenders = spenders.map((entry) => (entry.userId === userId ? { ...entry, monthlyCapUsd } : entry));
    input.value = monthlyCapUsd === null ? '' : String(monthlyCapUsd);
  };
</script>

<!-- Rows of the page's Spending section: who else may spend, each with a monthly limit. -->
{#if cloudMl}
  {#each spenders as spender (spender.userId)}
    <Row
      label={$t('frameleaf_cp_spender_limit', { values: { name: nameOf(spender.userId) } })}
      help={$t('frameleaf_cp_spender_help')}
    >
      <span class="fc-input-unit">
        <input
          class="fc-kit-number"
          type="number"
          min="0"
          max="100000"
          step="0.01"
          value={spender.monthlyCapUsd ?? ''}
          placeholder={$t('admin.frameleaf_cloud_ml_spenders_no_cap')}
          aria-label={$t('admin.frameleaf_cloud_ml_spenders_cap_for', { values: { name: nameOf(spender.userId) } })}
          {disabled}
          onchange={(event) => setCap(spender.userId, event.currentTarget)}
        />
        <span>{$t('frameleaf_cp_usd_month')}</span>
      </span>
      <Button
        {disabled}
        label={$t('admin.frameleaf_cloud_ml_spenders_remove', { values: { name: nameOf(spender.userId) } })}
        onclick={() => remove(spender.userId)}
      >
        <Icon icon={mdiClose} size="1.125rem" aria-hidden={true} />
      </Button>
    </Row>
  {/each}
  <Row
    label={$t('admin.frameleaf_cloud_ml_spenders_add_label')}
    help={`${spenders.length === 0 ? $t('admin.frameleaf_cloud_ml_spenders_empty') : ''} ${$t('admin.frameleaf_cloud_ml_spenders_note')}${edited ? ` ${$t('admin.frameleaf_cloud_ml_spenders_unsaved')}` : ''}`.trim()}
  >
    <select
      class="fl-control"
      aria-label={$t('admin.frameleaf_cloud_ml_spenders_add_label')}
      bind:value={chosen}
      disabled={disabled || candidates.length === 0}
    >
      <option value="">{$t('admin.frameleaf_cloud_ml_spenders_choose')}</option>
      {#each candidates as user (user.id)}
        <option value={user.id}>{user.name} · {user.email}</option>
      {/each}
    </select>
    <Button disabled={disabled || !chosen} onclick={add}>{$t('admin.frameleaf_cloud_ml_spenders_add')}</Button>
  </Row>
{/if}
