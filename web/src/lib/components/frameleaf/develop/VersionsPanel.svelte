<script lang="ts">
  /**
   * The Versions tab (PhotographyEditor.jsx): the untouched original and every version saved on the
   * server, with its render. Choosing a version loads its settings; a rendered one can also become the
   * version the library shows.
   */
  import { AssetMediaSize, type AssetDevelopRevisionResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiRedo, mdiRestore, mdiUndo } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';
  import PhotographyThumb from '$lib/components/frameleaf/PhotographyThumb.svelte';
  import { developFileUrl } from '$lib/frameleaf/develop-api';
  import { initialNativeRecipe, isNativeRecipe } from '$lib/frameleaf/native-develop';
  import type { RawDevelopSession } from '$lib/frameleaf/raw-develop-session.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';

  let {
    session,
    id,
    onSaveVersion,
    say,
  }: {
    session: RawDevelopSession;
    id: string;
    onSaveVersion: () => void;
    say: (message: string) => void;
  } = $props();

  const record = $derived(session.record(id));
  const original = $derived(getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail, edited: false }));
  const time = (value: string) =>
    new Date(value).toLocaleString($locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const status = (version: AssetDevelopRevisionResponseDto) =>
    version.isCurrent && version.status === 'rendered'
      ? $t('frameleaf_develop_version_current')
      : version.status === 'rendering'
        ? $t('frameleaf_editor_status_rendering', { values: { progress: version.progress } })
        : $t(`frameleaf_editor_status_${version.status}` as Translations);

  async function act(action: () => Promise<void>, failure: Translations) {
    try {
      await action();
    } catch {
      say($t(failure));
    }
  }
</script>

<div class="rde-inspector-heading">
  <strong>{$t('frameleaf_develop_tab_versions')}</strong>
  <button type="button" class="rde-link" onclick={onSaveVersion}>{$t('frameleaf_develop_save_current')}</button>
</div>
<p class="rde-muted">{$t('frameleaf_develop_versions_lead')}</p>

<div class="rde-version">
  <button type="button" onclick={() => session.change(id, initialNativeRecipe())}>
    <span class="rde-thumb"><PhotographyThumb src={original} /></span>
    <span
      ><strong>{$t('frameleaf_develop_original')}</strong><small>{$t('frameleaf_develop_original_detail')}</small></span
    >
    <Icon icon={mdiRestore} size="17" aria-hidden={true} />
  </button>
  {#if record.currentRevisionId}<div class="rde-version-actions">
      <button
        type="button"
        class="rde-button"
        onclick={() =>
          act(async () => {
            await session.revert(id);
            say($t('frameleaf_develop_original_shown'));
          }, 'frameleaf_develop_action_failed')}>{$t('frameleaf_develop_show_original')}</button
      >
    </div>{/if}
</div>

{#each record.revisions as version (version.id)}
  {@const native = isNativeRecipe(version.recipe)}
  <div class="rde-version">
    <button
      type="button"
      disabled={!native}
      onclick={() => {
        session.restore(id, version);
        say(
          $t('frameleaf_develop_version_loaded', {
            values: {
              name: version.label ?? $t('frameleaf_editor_version_number', { values: { revision: version.revision } }),
            },
          }),
        );
      }}
    >
      <span class="rde-thumb"
        ><PhotographyThumb
          src={version.hasPreview ? developFileUrl(id, version.id, undefined, version.renderedAt) : original}
        /></span
      >
      <span
        ><strong
          >{version.label ?? $t('frameleaf_editor_version_number', { values: { revision: version.revision } })}</strong
        ><small
          >{time(version.createdAt)} · {native ? status(version) : $t('frameleaf_develop_version_other_editor')}</small
        ></span
      >
      {#if native}<Icon icon={mdiRestore} size="17" aria-hidden={true} />{/if}
    </button>
    {#if version.error}<p class="rde-muted rde-version-actions">{version.error}</p>{/if}
    {#if (version.status === 'rendered' && !version.isCurrent) || ['failed', 'cancelled', 'saved', 'queued', 'rendering'].includes(version.status)}
      <div class="rde-version-actions">
        {#if version.status === 'rendered' && !version.isCurrent}<button
            type="button"
            class="rde-button"
            onclick={() => act(() => session.revert(id, version.id), 'frameleaf_develop_action_failed')}
            >{$t('frameleaf_develop_show_in_library')}</button
          >{/if}
        {#if ['failed', 'cancelled', 'saved'].includes(version.status) && native}<button
            type="button"
            class="rde-button"
            onclick={() => act(() => session.render(id, version.id), 'frameleaf_develop_action_failed')}
            >{$t('frameleaf_develop_render_again')}</button
          >{/if}
        {#if version.status === 'queued' || version.status === 'rendering'}<button
            type="button"
            class="rde-button"
            onclick={() => act(() => session.cancel(id, version.id), 'frameleaf_develop_action_failed')}
            >{$t('frameleaf_editor_cancel_render')}</button
          >{/if}
      </div>
    {/if}
  </div>
{/each}

<div class="rde-version-history">
  <span>{$t('frameleaf_develop_undo_steps', { values: { count: record.undo.length } })}</span>
  <button type="button" class="rde-button" disabled={record.undo.length === 0} onclick={() => session.undo(id)}
    ><Icon icon={mdiUndo} size="15" aria-hidden={true} />{$t('undo')}</button
  >
  <button type="button" class="rde-button" disabled={record.redo.length === 0} onclick={() => session.redo(id)}
    ><Icon icon={mdiRedo} size="15" aria-hidden={true} />{$t('frameleaf_editor_redo')}</button
  >
</div>
