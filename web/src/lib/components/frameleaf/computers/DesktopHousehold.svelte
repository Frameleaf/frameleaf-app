<script lang="ts">
  /**
   * Computers → Whose photos each computer works on (FL-1484, after the approved prototype's Office PC
   * "Whose photos it works on"). A Frameleaf Desktop helper works on the photos of the account signed in on
   * it; an administrator can let it work on everyone's photos at home. It counts as home, so it also does
   * the photos of people who keep theirs at home, and it never takes another account's Locked photos.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { setDesktopHousehold, type WorkerDesktopHelperDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  let { desktops, onChanged }: { desktops: WorkerDesktopHelperDto[]; onChanged: () => Promise<void> | void } = $props();

  const EVERYONE = 'everyone';
  const OWN = 'own';
  let saving = $state<string>();
  let failed = $state(false);

  const choose = async (desktop: WorkerDesktopHelperDto, value: string) => {
    saving = desktop.id;
    failed = false;
    try {
      await setDesktopHousehold({ id: desktop.id, desktopHouseholdDto: { enabled: value === EVERYONE } });
      await onChanged();
    } catch {
      failed = true;
    } finally {
      saving = undefined;
    }
  };
</script>

<Section title={$t('frameleaf_household_title')} description={$t('frameleaf_household_description')}>
  {#if failed}
    <InlineError compact message={$t('frameleaf_household_save_failed')} />
  {/if}
  {#each desktops as desktop (desktop.id)}
    {@const owner = desktop.ownerName ?? ''}
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
  {/each}
</Section>
