import { ModelDownloadKeyStatus } from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ModelDownloadKey from '$lib/components/frameleaf/computers/ModelDownloadKey.svelte';
import en from '../../../../../../i18n/en.json';

/** FL-1825: Settings → Computers → Advanced → Connections → Faster model downloads. */

const KEY = `hf_${'a'.repeat(34)}`;
const none = { status: ModelDownloadKeyStatus.None, savedAt: null, checkedAt: null };
const saved = {
  status: ModelDownloadKeyStatus.Saved,
  savedAt: '2026-11-27T10:00:00.000Z',
  checkedAt: '2026-11-27T10:00:00.000Z',
};

describe('ModelDownloadKey', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.isHttpError.mockImplementation((error) => typeof (error as { status?: unknown })?.status === 'number');
  });

  it('offers to add a key, with the cursor in the field when the dialog opens', async () => {
    sdkMock.getModelDownloadKey.mockResolvedValue(none);
    render(ModelDownloadKey);
    await userEvent.click(await screen.findByRole('button', { name: en.frameleaf_model_download_key_add }));
    const field = await screen.findByLabelText(en.frameleaf_model_download_key_field);
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByRole('button', { name: en.frameleaf_model_download_key_check_and_save })).toBeDisabled();
  });

  it('says when a pasted key is incomplete', async () => {
    sdkMock.getModelDownloadKey.mockResolvedValue(none);
    render(ModelDownloadKey);
    await userEvent.click(await screen.findByRole('button', { name: en.frameleaf_model_download_key_add }));
    await userEvent.type(await screen.findByLabelText(en.frameleaf_model_download_key_field), 'hf_abc');
    expect(screen.getByText(en.frameleaf_model_download_key_hint_partial)).toBeInTheDocument();
  });

  it('saves a key Hugging Face accepts', async () => {
    sdkMock.getModelDownloadKey.mockResolvedValue(none);
    sdkMock.setModelDownloadKey.mockResolvedValue(saved);
    render(ModelDownloadKey);
    await userEvent.click(await screen.findByRole('button', { name: en.frameleaf_model_download_key_add }));
    await userEvent.type(await screen.findByLabelText(en.frameleaf_model_download_key_field), KEY);
    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_model_download_key_check_and_save }));
    expect(sdkMock.setModelDownloadKey).toHaveBeenCalledWith({ modelDownloadKeyUpdateDto: { key: KEY } });
    expect(await screen.findByText(en.frameleaf_model_download_key_saved)).toBeInTheDocument();
  });

  it('shows Hugging Face refusing the key in the dialog and keeps it open', async () => {
    sdkMock.getModelDownloadKey.mockResolvedValue(none);
    sdkMock.setModelDownloadKey.mockRejectedValue({ status: 400 });
    render(ModelDownloadKey);
    await userEvent.click(await screen.findByRole('button', { name: en.frameleaf_model_download_key_add }));
    await userEvent.type(await screen.findByLabelText(en.frameleaf_model_download_key_field), KEY);
    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_model_download_key_check_and_save }));
    expect(await screen.findByText(en.frameleaf_model_download_key_not_accepted_body)).toBeInTheDocument();
    expect(screen.getByLabelText(en.frameleaf_model_download_key_field)).toBeInTheDocument();
  });

  it('says when Hugging Face stopped accepting a saved key', async () => {
    sdkMock.getModelDownloadKey.mockResolvedValue({ ...saved, status: ModelDownloadKeyStatus.Refused });
    render(ModelDownloadKey);
    expect(await screen.findByText(en.frameleaf_model_download_key_refused)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_model_download_key_stopped_title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_model_download_key_replace })).toBeInTheDocument();
  });

  it('removes the key after asking', async () => {
    sdkMock.getModelDownloadKey.mockResolvedValue(saved);
    sdkMock.removeModelDownloadKey.mockResolvedValue(undefined as never);
    render(ModelDownloadKey);
    await userEvent.click(await screen.findByRole('button', { name: en.frameleaf_model_download_key_remove }));
    await userEvent.click(await screen.findByRole('button', { name: en.frameleaf_model_download_key_remove_confirm }));
    expect(sdkMock.removeModelDownloadKey).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: en.frameleaf_model_download_key_add })).toBeInTheDocument();
  });
});
