<script lang="ts">
  /**
   * Support and feedback (S-3): the prototype's `HelpFeedback` (`design/frameleaf/template/src/
   * SystemPanels.jsx:226-315`) — a list of help rows and the third-party notices — in place of the
   * upstream modal's list of the upstream project's resources.
   *
   * The help rows use the addresses this installation is configured with (`FRAMELEAF_DOCS_URL`,
   * `FRAMELEAF_SUPPORT_URL`, … validated https by the server, FL-135) and a row without one is left
   * out; nothing falls back to another project's sites. FL-190: the upstream attribution lives on the
   * About screen only, so this dialog names neither the upstream project nor its sites.
   */
  import AcknowledgementsList from '$lib/components/frameleaf/AcknowledgementsList.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { type ServerAboutResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiBookOpenOutline,
    mdiBugOutline,
    mdiCertificateOutline,
    mdiChevronDown,
    mdiCommentTextOutline,
    mdiGithub,
    mdiLightbulbOnOutline,
    mdiOpenInNew,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    onClose: () => void;
    info: ServerAboutResponseDto;
  };

  const { onClose, info }: Props = $props();

  let open = $state(true);
  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  type Row = { id: string; icon: string; title: Translations; text: Translations; href?: string };

  const rows: Row[] = $derived(
    (
      [
        {
          id: 'documentation',
          icon: mdiBookOpenOutline,
          title: 'documentation',
          text: 'frameleaf_help_documentation_text',
          href: info.thirdPartyDocumentationUrl,
        },
        {
          id: 'community',
          icon: mdiCommentTextOutline,
          title: 'frameleaf_help_community',
          text: 'frameleaf_help_community_text',
          href: info.thirdPartySupportUrl,
        },
        {
          id: 'problem',
          icon: mdiBugOutline,
          title: 'frameleaf_help_problem',
          text: 'frameleaf_help_problem_text',
          href: info.thirdPartyBugFeatureUrl,
        },
        {
          id: 'feature',
          icon: mdiLightbulbOnOutline,
          title: 'frameleaf_help_feature',
          text: 'frameleaf_help_feature_text',
          href: info.thirdPartyBugFeatureUrl,
        },
        {
          id: 'source',
          icon: mdiGithub,
          title: 'frameleaf_help_source',
          text: 'frameleaf_help_source_text',
          href: info.thirdPartySourceUrl ?? info.repositoryUrl,
        },
      ] satisfies Row[]
    ).filter((row) => row.href),
  );

  // Name, what Frameleaf uses it for, and its licence; versions come from this server. Everything
  // else Frameleaf credits (Studio's Freecut editor, models, voices, fonts, assets) follows in the
  // acknowledgements list, with its licence text.
  const notices: { name: string; role: string; licence: string; version?: string; href?: string }[] = $derived(
    [
      { name: 'Node.js', role: $t('frameleaf_help_notice_runtime'), licence: 'MIT', version: info.nodejs },
      { name: 'libvips', role: $t('frameleaf_help_notice_images'), licence: 'LGPL-2.1', version: info.libvips },
      {
        name: 'ImageMagick',
        role: $t('frameleaf_help_notice_images'),
        licence: 'ImageMagick',
        version: info.imagemagick,
      },
      { name: 'FFmpeg', role: $t('frameleaf_help_notice_video'), licence: 'LGPL-2.1 / GPL-2.0', version: info.ffmpeg },
      {
        name: 'ExifTool',
        role: $t('frameleaf_help_notice_metadata'),
        licence: 'Artistic / GPL',
        version: info.exiftool,
      },
    ].filter((notice) => notice.version),
  );
</script>

{#snippet link(row: Row, first: boolean)}
  <li>
    <a class="help-link" href={row.href} target="_blank" rel="noreferrer" data-initial-focus={first ? '' : undefined}>
      <Icon icon={row.icon} size="20" aria-hidden={true} />
      <div>
        <strong>{$t(row.title)}</strong>
        <span>{$t(row.text)}</span>
      </div>
      <Icon icon={mdiOpenInNew} size="16" aria-hidden={true} />
      <span class="sr-only">{$t('frameleaf_opens_in_new_tab')}</span>
    </a>
  </li>
{/snippet}

<Dialog title={$t('support_and_feedback')} closeLabel={$t('close')} bind:open>
  <ul class="help-list">
    {#each rows as row, index (row.id)}
      {@render link(row, index === 0)}
    {/each}
    <li>
      <details class="help-notices">
        <summary>
          <span class="help-link">
            <Icon icon={mdiCertificateOutline} size="20" aria-hidden={true} />
            <div>
              <strong>{$t('frameleaf_help_notices')}</strong>
              <span>{$t('frameleaf_help_notices_text')}</span>
            </div>
            <Icon icon={mdiChevronDown} size="16" aria-hidden={true} />
          </span>
        </summary>
        <table>
          <tbody>
            {#each notices as notice (notice.name)}
              <tr>
                <td>
                  {#if notice.href}
                    <a href={notice.href} target="_blank" rel="noreferrer">{notice.name}</a>
                  {:else}
                    {notice.name}
                  {/if}
                </td>
                <td>{notice.role}</td>
                <td>{notice.licence}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="help-credit">{$t('frameleaf_help_notice_freecut_credit')}</p>
        <AcknowledgementsList />
      </details>
    </li>
  </ul>
</Dialog>

<style>
  /* design/frameleaf/template/src/system.css `.help-list` … `.help-notices`. */
  .help-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .help-link {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-text);
    text-decoration: none;
    width: 100%;
    text-align: left;
    min-height: 56px;
  }
  .help-link:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .help-link > :global(svg) {
    color: var(--fl-muted);
    flex-shrink: 0;
  }
  .help-link > div {
    flex: 1;
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .help-link strong {
    font-weight: 600;
  }
  .help-link div span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .help-notices {
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .help-notices summary {
    list-style: none;
    cursor: pointer;
  }
  .help-notices summary::-webkit-details-marker {
    display: none;
  }
  .help-notices table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-small);
  }
  .help-notices td {
    padding: 8px 12px;
    border-top: 1px solid var(--fl-border);
    vertical-align: top;
  }
  .help-notices td:first-child {
    font-weight: 600;
    white-space: nowrap;
  }
  .help-notices td:last-child {
    color: var(--fl-muted);
    text-align: right;
    white-space: nowrap;
  }
  .help-notices td a {
    color: inherit;
  }
  .help-credit {
    margin: 0;
    padding: 8px 12px 12px;
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
