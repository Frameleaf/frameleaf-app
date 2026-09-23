<script lang="ts">
  import { goto } from '$app/navigation';
  import AuthPageLayout from '$lib/components/layouts/AuthPageLayout.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { updateMyUser } from '@immich/sdk';
  import PasswordStrength from '$lib/components/frameleaf/PasswordStrength.svelte';
  import { passwordStrength } from '$lib/frameleaf/password-strength';
  import { Button, Field, HelperText, Input, PasswordInput } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let password = $state('');
  let passwordConfirm = $state('');
  const valid = $derived(
    passwordStrength(password).acceptable && password === passwordConfirm && passwordConfirm.length > 0,
  );
  const errorMessage = $derived(
    passwordConfirm.length === 0 || password === passwordConfirm ? '' : $t('frameleaf_auth_passwords_mismatch_yet'),
  );

  const onSubmit = async () => {
    if (!valid) {
      return;
    }

    await updateMyUser({ userUpdateMeDto: { password } });
    await goto(Route.logout());
  };
</script>

<AuthPageLayout
  title={$t('frameleaf_auth_change_password_title')}
  subtitle={$t('frameleaf_auth_change_password_reason')}
>
  <form onsubmit={onSubmit} class="flex flex-col gap-4">
    <Field label={$t('frameleaf_auth_account')}>
      <Input value={authManager.user.email} readonly autocomplete="username" />
    </Field>

    <Field label={$t('new_password')} required>
      <PasswordInput bind:value={password} autocomplete="new-password" />
    </Field>

    <PasswordStrength {password} />

    <Field label={$t('frameleaf_auth_confirm_new_password')} required>
      <PasswordInput bind:value={passwordConfirm} autocomplete="new-password" />
      <HelperText color="danger">{errorMessage}</HelperText>
    </Field>

    <Button class="mt-2" type="submit" size="large" shape="round" fullWidth disabled={!valid}
      >{$t('frameleaf_auth_save_and_continue')}</Button
    >
    <a class="self-center text-sm underline" href={Route.logout()}>{$t('frameleaf_auth_sign_out_instead')}</a>
  </form>
</AuthPageLayout>
