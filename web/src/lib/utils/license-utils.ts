import { setServerLicense, setUserLicense, type LicenseResponseDto } from '@immich/sdk';
import { PUBLIC_IMMICH_PAY_HOST } from '$env/static/public';
import { authManager } from '$lib/managers/auth-manager.svelte';

export const activateProduct = async (licenseKey: string, activationKey: string): Promise<LicenseResponseDto> => {
  // TODO is this needed?
  await authManager.load();

  const isServerActivation = authManager.user.isAdmin && licenseKey.search('IMSV') !== -1;
  const licenseKeyDto = { licenseKey, activationKey };
  // Send server key to user activation if user is not admin
  return isServerActivation ? setServerLicense({ licenseKeyDto }) : setUserLicense({ licenseKeyDto });
};

export const getActivationKey = async (licenseKey: string): Promise<string> => {
  const response = await fetch(new URL(`/api/v1/activate/${licenseKey}`, PUBLIC_IMMICH_PAY_HOST).href);
  if (!response.ok) {
    throw new Error('Failed to fetch activation key');
  }
  return response.text();
};
