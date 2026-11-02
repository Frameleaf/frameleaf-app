import { render, screen, waitFor } from '@testing-library/svelte';
import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
import GetCloudHost from './GetCloudHost.svelte';

vi.mock('$lib/components/frameleaf/cloud/GetCloudSheet.svelte', async () => {
  const { default: Stub } = await import('./__mocks__/GetCloudSheetStub.svelte');
  return { default: Stub };
});

afterEach(() => getCloudManager.close());

it('renders nothing until a gate asks for the sheet, then mounts it with the request', async () => {
  render(GetCloudHost);
  expect(screen.queryByTestId('get-cloud-sheet')).not.toBeInTheDocument();
  getCloudManager.open('remote', { topUpUrl: 'https://cloud.example/top-up' });
  const sheet = await screen.findByTestId('get-cloud-sheet');
  expect(sheet).toHaveTextContent('remote https://cloud.example/top-up');
  getCloudManager.close();
  await waitFor(() => expect(screen.queryByTestId('get-cloud-sheet')).not.toBeInTheDocument());
});
