import { PhotographyContractEventType, PhotographyContractSignatureType } from '@frameleaf/sdk';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PhotographyContractSign from './PhotographyContractSign.svelte';
import PhotographyContracts from './PhotographyContracts.svelte';

const token = 'a'.repeat(64);
const contract = {
  studio: { name: 'Cedar & Light', email: 'studio@example.test', color: '#577059' },
  name: 'Portrait agreement',
  body: 'Cedar & Light will photograph Morgan Ellis.',
  documentSha256: 'b'.repeat(64),
  signed: false,
  signerName: null,
  signedAt: null,
  history: [],
};
const template = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Portrait',
  body: 'Hi {client_name}, {total}',
  updatedAt: '2027-01-01T00:00:00.000Z',
};

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.isHttpError.mockImplementation((error) => typeof (error as { status?: number })?.status === 'number');
});

it('signs with the typed name and the hash of the text shown, then offers the signed copy', async () => {
  sdkMock.photographyPublicContract.mockResolvedValue(contract);
  sdkMock.photographySignContract.mockResolvedValue({
    ...contract,
    signed: true,
    signerName: 'Morgan Ellis',
    signedAt: '2027-01-01T00:00:00.000Z',
    history: [{ type: PhotographyContractEventType.Signed, at: '2027-01-01T00:00:00.000Z' }],
  });
  render(PhotographyContractSign, { token });
  const button = await screen.findByRole('button', { name: 'Sign agreement' });
  expect(button).toBeDisabled();
  await fireEvent.input(screen.getByLabelText('Full name'), { target: { value: 'Morgan Ellis' } });
  expect(button).toBeDisabled();
  await fireEvent.click(screen.getByLabelText(en.frameleaf_clients_contract_consent));
  expect(button).toBeEnabled();
  await fireEvent.click(button);
  await waitFor(() =>
    expect(sdkMock.photographySignContract).toHaveBeenCalledExactlyOnceWith({
      token,
      photographyContractSignDto: {
        name: 'Morgan Ellis',
        signatureType: PhotographyContractSignatureType.Typed,
        consent: true,
        documentSha256: contract.documentSha256,
      },
    }),
  );
  expect(await screen.findByText('Agreement signed')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download signed agreement' })).toHaveAttribute(
    'href',
    `/api/photography/sign/${token}/pdf`,
  );
});

it('needs a drawing before a drawn signature can be sent', async () => {
  sdkMock.photographyPublicContract.mockResolvedValue(contract);
  render(PhotographyContractSign, { token });
  await fireEvent.input(await screen.findByLabelText('Full name'), { target: { value: 'Morgan' } });
  await fireEvent.click(screen.getByLabelText(en.frameleaf_clients_contract_consent));
  await fireEvent.click(screen.getByLabelText('Draw my signature'));
  expect(screen.getByRole('button', { name: 'Sign agreement' })).toBeDisabled();
});

it('explains an expired or voided link', async () => {
  sdkMock.photographyPublicContract.mockRejectedValue({ status: 404 });
  render(PhotographyContractSign, { token });
  expect(await screen.findByText('This agreement link is unavailable')).toBeInTheDocument();
  expect(screen.getByText('Ask the studio for a new link.')).toBeInTheDocument();
});

it('sends a contract from a template, asking only for the fields it uses', async () => {
  sdkMock.photographyContractTemplates.mockResolvedValue({ items: [template], fields: [] });
  sdkMock.photographyContracts.mockResolvedValue({ items: [], mailReady: true });
  sdkMock.photographyCreateContract.mockResolvedValue({ id: 'created' } as never);
  sdkMock.photographySendContract.mockResolvedValue({ id: 'created' } as never);
  render(PhotographyContracts);
  await fireEvent.click(await screen.findByRole('button', { name: 'Send contract' }));
  expect(screen.queryByLabelText('Session date')).not.toBeInTheDocument();
  await fireEvent.input(screen.getByLabelText('Client'), { target: { value: 'Morgan' } });
  await fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'morgan@example.test' } });
  await fireEvent.input(screen.getByLabelText('Total'), { target: { value: '$350' } });
  await fireEvent.submit(screen.getByLabelText('Client').closest('form')!);
  await waitFor(() => expect(sdkMock.photographySendContract).toHaveBeenCalledExactlyOnceWith({ id: 'created' }));
  expect(sdkMock.photographyCreateContract).toHaveBeenCalledExactlyOnceWith({
    photographyContractCreateDto: {
      templateId: template.id,
      clientName: 'Morgan',
      clientEmail: 'morgan@example.test',
      total: '$350',
    },
  });
});
