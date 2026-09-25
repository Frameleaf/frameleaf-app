import {
  MlDestinationKind,
  PetRecognitionRunStatus,
  PetRecognitionUnavailableReason,
  type PetRecognitionStatusResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import en from '../../../../../../i18n/en.json';
import PetRecognitionPanel from './PetRecognitionPanel.svelte';

/**
 * FL-58: where pet recognition runs, or why it cannot, from the server's own status. The fake
 * statuses stand for the three worker situations the story names: local only, cloud only and an
 * unavailable worker. Nothing here talks to a worker.
 */
describe('PetRecognitionPanel', () => {
  const status = (overrides: Partial<PetRecognitionStatusResponseDto> = {}): PetRecognitionStatusResponseDto => ({
    available: true,
    reason: null,
    detail: null,
    destination: { kind: MlDestinationKind.Local, name: 'This server' },
    hasConfirmedPhotos: true,
    run: null,
    ...overrides,
  });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  const setup = (recognition: PetRecognitionStatusResponseDto, isAdmin = true) => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    render(PetRecognitionPanel, { recognition, isAdmin, onStart, onCancel });
    return { onStart, onCancel };
  };

  it('says recognition runs on this server when it is routed locally', async () => {
    const { onStart } = setup(status());

    expect(screen.getByTestId('pet-recognition-destination')).toHaveTextContent(
      en.frameleaf_pets_recognition_runs_local,
    );
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pets_recognition_start }));
    expect(onStart).toHaveBeenCalled();
  });

  it('calls the cloud worker Frameleaf Cloud', () => {
    setup(status({ destination: { kind: MlDestinationKind.FrameleafCloud, name: 'Cloud worker' } }));

    const row = screen.getByTestId('pet-recognition-destination');
    expect(row).toHaveTextContent('Frameleaf Cloud');
    expect(row).not.toHaveTextContent('Cloud worker');
  });

  it('names a computer on the network', () => {
    setup(status({ destination: { kind: MlDestinationKind.Lan, name: 'Garage PC' } }));

    expect(screen.getByTestId('pet-recognition-destination')).toHaveTextContent('Garage PC');
  });

  it('explains an unavailable worker and links an administrator to processing settings', () => {
    setup(
      status({
        available: false,
        reason: PetRecognitionUnavailableReason.DestinationUnhealthy,
        detail: 'This server did not answer',
      }),
    );

    const row = screen.getByTestId('pet-recognition-unavailable');
    expect(row).toHaveTextContent(en.frameleaf_pets_recognition_reason_destination_unhealthy);
    expect(screen.getByRole('link', { name: en.frameleaf_pets_recognition_open_settings })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_pets_recognition_start })).not.toBeInTheDocument();
  });

  it('asks someone who is not an administrator to ask one', () => {
    setup(status({ available: false, reason: PetRecognitionUnavailableReason.ConsentMissing }), false);

    expect(screen.getByTestId('pet-recognition-unavailable')).toHaveTextContent(
      en.frameleaf_pets_recognition_ask_admin,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows a running run with its progress and a way to stop it, after a reload too', async () => {
    const { onCancel } = setup(
      status({
        run: {
          id: 'run',
          status: PetRecognitionRunStatus.Running,
          assetCount: 8,
          processedCount: 2,
          proposalCount: 1,
          destinationKind: MlDestinationKind.Local,
          error: null,
          createdAt: '2026-09-25T00:00:00.000Z',
          finishedAt: null,
        },
      }),
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '25');
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_pets_recognition_cancel }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('keeps the start button off until a pet is confirmed in a photo', () => {
    setup(status({ hasConfirmedPhotos: false }));

    expect(screen.getByRole('button', { name: en.frameleaf_pets_recognition_start })).toBeDisabled();
    expect(screen.getByText(en.frameleaf_pets_recognition_needs_photos)).toBeInTheDocument();
  });
});
