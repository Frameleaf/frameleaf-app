import {
  PhotographyCampaignAudienceSource,
  PhotographyCampaignTemplate,
  PhotographyCampaignStatus,
} from '@frameleaf/sdk';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PhotographyCampaigns from './PhotographyCampaigns.svelte';

const campaign = {
  id: '00000000-0000-4000-8000-000000000001',
  revision: '00000000-0000-4000-8000-000000000002',
  name: 'Autumn prints',
  templateKey: PhotographyCampaignTemplate.PrintSale,
  subject: 'Your prints',
  body: 'Choose your prints.',
  audience: { source: PhotographyCampaignAudienceSource.Clients },
  status: PhotographyCampaignStatus.Draft,
  scheduledFor: null,
  sentCount: 0,
  failedCount: 0,
  pendingCount: 0,
  uncertainCount: 0,
  unsubscribedCount: 0,
};
beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.photographyCampaigns.mockResolvedValue({
    items: [campaign],
    clients: 2,
    leads: 1,
    mailReady: true,
    sender: 'studio@example.test',
  });
  sdkMock.photographySaveCampaign.mockResolvedValue(campaign);
  sdkMock.photographyPreviewCampaign.mockResolvedValue({
    html: '<p>Your prints</p>',
    text: 'Your prints',
    sender: 'studio@example.test',
    recipients: 2,
  });
  sdkMock.photographyScheduleCampaign.mockResolvedValue({ ...campaign, status: PhotographyCampaignStatus.Scheduled });
  sdkMock.photographyTestCampaign.mockResolvedValue(undefined as never);
});

it('requires preview and confirmation, then schedules exactly the saved revision', async () => {
  render(PhotographyCampaigns, { shoots: [] });
  await fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await fireEvent.submit(screen.getByLabelText('Subject').closest('form')!);
  expect(await screen.findByTitle('Preview')).toHaveAttribute('sandbox', '');
  expect(sdkMock.photographyScheduleCampaign).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('button', { name: 'Send or schedule' }));
  expect(sdkMock.photographyScheduleCampaign).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('button', { name: 'Confirm send now' }));
  await waitFor(() =>
    expect(sdkMock.photographyScheduleCampaign).toHaveBeenCalledExactlyOnceWith({
      id: campaign.id,
      photographyCampaignScheduleDto: { expectedRevision: campaign.revision },
    }),
  );
});

it('tests only the selected campaign without scheduling a send', async () => {
  render(PhotographyCampaigns, { shoots: [] });
  await fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await fireEvent.submit(screen.getByLabelText('Subject').closest('form')!);
  await fireEvent.click(await screen.findByRole('button', { name: 'Send test to me' }));
  await waitFor(() => expect(sdkMock.photographyTestCampaign).toHaveBeenCalledExactlyOnceWith({ id: campaign.id }));
  expect(sdkMock.photographyScheduleCampaign).not.toHaveBeenCalled();
});

it('keeps test and send disabled when email delivery is unavailable', async () => {
  sdkMock.photographyCampaigns.mockResolvedValue({
    items: [campaign],
    clients: 2,
    leads: 1,
    mailReady: false,
    sender: '',
  });
  render(PhotographyCampaigns, { shoots: [] });
  await fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await fireEvent.submit(screen.getByLabelText('Subject').closest('form')!);
  expect(await screen.findByRole('button', { name: 'Send test to me' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send or schedule' })).toBeDisabled();
});
