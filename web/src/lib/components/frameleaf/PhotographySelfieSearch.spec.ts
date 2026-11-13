import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { PhotographyError } from '$lib/frameleaf/photography/errors';
import { searchGallerySelfie } from '$lib/frameleaf/photography/workflow-api';
import PhotographySelfieSearch from './PhotographySelfieSearch.svelte';

vi.mock('$lib/frameleaf/photography/workflow-api', () => ({ searchGallerySelfie: vi.fn() }));
beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.mocked(searchGallerySelfie).mockReset();
});
const props = () => ({
  open: true,
  galleryId: 'gallery',
  session: 'scoped',
  onResults: vi.fn(),
  onAccessEnded: vi.fn(),
});
async function submitSelfie() {
  const sheet = screen.getByRole('dialog');
  await fireEvent.change(within(sheet).getByLabelText('Upload a selfie'), {
    target: { files: [new File(['selfie'], 'me.jpg', { type: 'image/jpeg' })] },
  });
  await fireEvent.click(within(sheet).getByRole('checkbox'));
  await fireEvent.click(within(sheet).getByRole('button', { name: 'Find my photos' }));
}
it('offers upload when camera permission is denied and requires consent', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const camera = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: camera } });
  try {
    render(PhotographySelfieSearch, props());
    await fireEvent.click(screen.getByRole('button', { name: 'Take a selfie' }));
    await screen.findByText('The camera is unavailable. You can upload a selfie instead.');
    expect(screen.getByLabelText('Upload a selfie')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find my photos' })).toBeDisabled();
    expect(camera).toHaveBeenCalledWith({ video: { facingMode: 'user' }, audio: false });
  } finally {
    if (original) {
      Object.defineProperty(navigator, 'mediaDevices', original);
    } else {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  }
});
it.each(['selfie_no_face', 'selfie_multiple_faces', 'selfie_invalid_image', 'selfie_unavailable'] as const)(
  'shows the translated %s error and clears the selfie before retry',
  async (code) => {
    vi.mocked(searchGallerySelfie).mockRejectedValue(new PhotographyError(code, 400));
    render(PhotographySelfieSearch, props());
    await submitSelfie();
    expect(await screen.findByRole('alert')).toHaveTextContent(en[`frameleaf_clients_${code}`]);
    await fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
    expect(screen.getByRole('button', { name: 'Find my photos' })).toBeDisabled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  },
);
it('shows empty results and a rate-limit delay, with a fresh image required to retry', async () => {
  vi.mocked(searchGallerySelfie).mockResolvedValueOnce({ captureIds: [] });
  vi.mocked(searchGallerySelfie).mockRejectedValueOnce(new PhotographyError('wait', 429, 12));
  render(PhotographySelfieSearch, props());
  await submitSelfie();
  await screen.findByText('No matches found');
  await fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
  await submitSelfie();
  expect(await screen.findByRole('alert')).toHaveTextContent(/Please wait \d+ seconds before searching again\./);
  await fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
  expect(screen.getByRole('button', { name: 'Find my photos' })).toBeDisabled();
});
it('aborts a pending upload and ignores late results when closed', async () => {
  let complete!: (result: { captureIds: string[] }) => void;
  vi.mocked(searchGallerySelfie).mockImplementation(() => new Promise((resolve) => (complete = resolve)));
  const input = props();
  render(PhotographySelfieSearch, input);
  await submitSelfie();
  const signal = vi.mocked(searchGallerySelfie).mock.calls[0][3]!;
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(signal.aborted).toBe(true));
  complete({ captureIds: ['capture'] });
  await tick();
  expect(input.onResults).not.toHaveBeenCalled();
});
it('stops a camera stream that arrives after the sheet is destroyed', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  let supply!: (stream: MediaStream) => void;
  const stop = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => new Promise<MediaStream>((resolve) => (supply = resolve)) },
  });
  try {
    const page = render(PhotographySelfieSearch, props());
    await fireEvent.click(screen.getByRole('button', { name: 'Take a selfie' }));
    page.unmount();
    supply({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  } finally {
    if (original) {
      Object.defineProperty(navigator, 'mediaDevices', original);
    } else {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  }
});

it('stops the live camera as soon as the sheet closes', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const stop = vi.fn();
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
  });
  try {
    render(PhotographySelfieSearch, props());
    await fireEvent.click(screen.getByRole('button', { name: 'Take a selfie' }));
    await screen.findByLabelText('Selfie camera preview');
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(stop).toHaveBeenCalled());
  } finally {
    play.mockRestore();
    if (original) {
      Object.defineProperty(navigator, 'mediaDevices', original);
    } else {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  }
});
