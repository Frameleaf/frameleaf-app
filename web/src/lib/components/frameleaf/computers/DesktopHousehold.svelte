<script lang="ts">
  /**
   * Computers → Whose photos each computer works on (FL-1484, after the approved prototype's Office PC
   * "Whose photos it works on"). A Frameleaf Desktop helper works on the photos of the account signed in on
   * it; an administrator can let it work on everyone's photos at home. It counts as home, so it also does
   * the photos of people who keep theirs at home, and it never takes another account's Locked photos.
   *
   * FL-1761: each helper also has "Playback copies of videos", off until someone turns it on. Other people's
   * videos are a second choice, offered only to a computer that works on everyone's photos.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { setDesktopHousehold, setDesktopTranscode, type WorkerDesktopHelperDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  let { desktops, onChanged }: { desktops: WorkerDesktopHelperDto[]; onChanged: () => Promise<void> | void } = $props();

  const EVERYONE = 'everyone';
  const OWN = 'own';
  let saving = $state<string>();
  let failed = $state(false);

  const save = async (desktop: WorkerDesktopHelperDto, change: () => Promise<unknown>) => {
    saving = desktop.id;
    failed = false;
    try {
      await change();
      await onChanged();
    } catch {
      failed = true;
    } finally {
      saving = undefined;
    }
  };

  const choose = (desktop: WorkerDesktopHelperDto, value: string) =>
    save(desktop, () => setDesktopHousehold({ id: desktop.id, desktopHouseholdDto: { enabled: value === EVERYONE } }));

  const setCopies = (desktop: WorkerDesktopHelperDto, enabled: boolean, everyone: boolean) =>
    save(desktop, () =>
      setDesktopTranscode({ id: desktop.id, desktopTranscodeSettingsDto: { enabled, everyone: enabled && everyone } }),
    );
</script>

<Section title={$t('frameleaf_household_title')} description={$t('frameleaf_household_description')}>
  {#if failed}
    <InlineError compact message={$t('frameleaf_household_save_failed')} />
  {/if}
  {#each desktops as desktop (desktop.id)}
    {@const owner = desktop.ownerName ?? ''}
    {@const copies = desktop.transcodeEnabled === true}
    {@const everyone = desktop.transcodeEveryone === true}
    <Row
      label={desktop.name}
      help={desktop.household
        ? $t('frameleaf_household_everyone_help')
        : $t('frameleaf_household_own_help', { values: { name: owner } })}
    >
      <SegmentedControl
        label={$t('frameleaf_household_label', { values: { name: desktop.name } })}
        options={[
          { value: EVERYONE, label: $t('frameleaf_household_everyone') },
          { value: OWN, label: $t('frameleaf_household_own', { values: { name: owner } }) },
        ]}
        value={desktop.household ? EVERYONE : OWN}
        disabled={saving !== undefined}
        onChange={(value) => void choose(desktop, value)}
      />
    </Row>
    <Row label={$t('frameleaf_household_copies')} help={$t('frameleaf_household_copies_help')}>
      <Switch
        label={$t('frameleaf_household_copies_label', { values: { name: desktop.name } })}
        checked={copies}
        held={saving !== undefined}
        onChange={(on) => void setCopies(desktop, on, false)}
      />
    </Row>
    {#if copies && desktop.household}
      <Row
        label={$t('frameleaf_household_copies_everyone')}
        help={$t('frameleaf_household_copies_everyone_help', { values: { name: owner } })}
      >
        <Switch
          label={$t('frameleaf_household_copies_everyone_label', { values: { name: desktop.name } })}
          checked={everyone}
          held={saving !== undefined}
          onChange={(on) => void setCopies(desktop, true, on)}
        />
      </Row>
    {/if}
    {#if desktop.transcoding}
      <Row
        label={$t('frameleaf_household_working_on')}
        help={$t('frameleaf_household_working_progress', { values: { percent: desktop.transcoding.progress } })}
      >
        <span class="working-file">{desktop.transcoding.fileName ?? $t('frameleaf_household_working_private')}</span>
      </Row>
    {/if}
  {/each}
</Section>

<style>
  .working-file {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
</style>
