<script lang="ts">
  /**
   * Activate supporter status for this account, or register the server support key (FL-67), from
   * the `personal-supporter-activate` form of the design template's `PersonalForm`.
   *
   * The two are separate actions: `personal` only ever calls `setUserLicense` and accepts a
   * personal (IMCL) key; `server` is offered to administrators only, only calls
   * `setServerLicense` and accepts a server (IMSV) key. The activation itself is unchanged from
   * the previous screen: the deployment-configured activation service returns the activation key
   * for the entered product key. No purchase or activation service is invented; the key never
   * leaves this dialog except to those two requests.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { licenseKeyKind } from '$lib/frameleaf/personal-access';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getActivationKey } from '$lib/utils/license-utils';
  import { setServerLicense, setUserLicense } from '@immich/sdk';
  import { t } from 'svelte-i18n';
  import './access.css';

  let { kind, onClose }: { kind: 'personal' | 'server'; onClose: (activated?: boolean) => void } = $props();

  let open = $state(true);
  let key = $state('');
  let working = $state(false);
  let error = $state('');
  let activated = false;

  const hintId = $props.id();
  const trimmed = $derived(key.trim());
  const wrongKind = $derived(trimmed.length > 0 && licenseKeyKind(trimmed) !== kind);
  const server = $derived(kind === 'server');
  const title = $derived(
    server ? $t('frameleaf_access_server_key_register') : $t('frameleaf_access_supporter_activate'),
  );
  const hint = $derived(server ? $t('frameleaf_access_server_key_hint') : $t('frameleaf_access_supporter_key_hint'));
  const wrongKindText = $derived(
    server ? $t('frameleaf_access_server_key_wrong_kind') : $t('frameleaf_access_supporter_key_wrong_kind'),
  );

  $effect(() => {
    if (open) {
      return;
    }

    key = '';
    onClose(activated);
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working || !trimmed || wrongKind) {
      return;
    }

    working = true;
    error = '';
    try {
      const licenseKey = trimmed;
      const activationKey = await getActivationKey(licenseKey);
      const licenseKeyDto = { licenseKey, activationKey };
      await (kind === 'server' ? setServerLicense({ licenseKeyDto }) : setUserLicense({ licenseKeyDto }));
      activated = true;
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_access_supporter_activate_failed');
    } finally {
      working = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('close')} bind:open>
  <form class="fl-access-form" autocomplete="off" onsubmit={submit}>
    <label class="fl-access-field">
      <span>{$t('frameleaf_access_supporter_key')}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="password"
        required
        autofocus
        autocomplete="off"
        spellcheck="false"
        maxlength={256}
        aria-describedby={hintId}
        disabled={working}
        bind:value={key}
      />
    </label>
    <p id={hintId} class="fl-access-footnote">{hint}</p>
    {#if wrongKind}
      <p class="fl-access-error" role="alert">{wrongKindText}</p>
    {/if}
    {#if error}
      <p class="fl-access-error" role="alert">{error}</p>
    {/if}
    <footer>
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={working || !trimmed || wrongKind}>{title}</Button>
    </footer>
  </form>
</Dialog>
