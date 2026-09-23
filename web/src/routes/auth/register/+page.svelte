<script lang="ts">
  import { goto } from '$app/navigation';
  import AuthPageLayout from '$lib/components/layouts/AuthPageLayout.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { signUpAdmin } from '@immich/sdk';
  import PasswordStrength from '$lib/components/frameleaf/PasswordStrength.svelte';
  import { passwordStrength } from '$lib/frameleaf/password-strength';
  import { Alert, Button, Field, Input, PasswordInput } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  let email = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let name = $state('');
  let loading = $state(false);
  let errorMessage = $derived(
    password === confirmPassword || confirmPassword.length === 0 ? '' : $t('password_does_not_match'),
  );
  const valid = $derived(
    passwordStrength(password).acceptable && password === confirmPassword && confirmPassword.length > 0,
  );

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const onSubmit = async (event: Event) => {
    event.preventDefault();

    if (!valid || loading) {
      return;
    }

    loading = true;
    errorMessage = '';

    try {
      await signUpAdmin({ signUpDto: { email, password, name } });
      await serverConfigManager.loadServerConfig();
      await goto(Route.login());
    } catch (error) {
      handleError(error, $t('errors.unable_to_create_admin_account'));
      errorMessage = $t('errors.unable_to_create_admin_account');
    } finally {
      loading = false;
    }
  };
</script>

<AuthPageLayout title={$t('frameleaf_auth_register_title')} subtitle={$t('frameleaf_auth_register_subtitle')}>
  <form onsubmit={onSubmit} method="post" class="flex flex-col gap-4">
    <Field label={$t('name')} required>
      <Input bind:value={name} type="text" autocomplete="name" />
    </Field>

    <Field label={$t('email')} required>
      <Input bind:value={email} type="email" autocomplete="username" />
    </Field>

    <Field label={$t('password')} required>
      <PasswordInput bind:value={password} autocomplete="new-password" />
    </Field>

    <PasswordStrength {password} />

    <Field label={$t('confirm_password')} required>
      <PasswordInput bind:value={confirmPassword} autocomplete="new-password" />
    </Field>

    {#if errorMessage}
      <Alert color="danger" title={errorMessage} size="medium" class="mt-4" />
    {/if}

    <Button class="mt-4" type="submit" size="giant" shape="round" fullWidth disabled={!valid || loading} {loading}
      >{$t('frameleaf_auth_create_account')}</Button
    >
  </form>
</AuthPageLayout>
