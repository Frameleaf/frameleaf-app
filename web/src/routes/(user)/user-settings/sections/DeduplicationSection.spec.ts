import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import DeduplicationSection from './DeduplicationSection.svelte';

it('opens universal file trash without a deduplication plan or account picker', async () => {
  addMessages('dev', en);
  sdkMock.getFileTrash.mockResolvedValue({ items: [], total: 0, totalBytes: 0 });
  render(DeduplicationSection);
  expect(await screen.findByText(en.frameleaf_file_trash_empty)).toBeInTheDocument();
  expect(sdkMock.getFileTrash).toHaveBeenCalledWith({ size: 100 });
  expect(sdkMock.getPhysicalDeduplicationPreview).not.toHaveBeenCalled();
  expect(sdkMock.searchUsersAdmin).not.toHaveBeenCalled();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
