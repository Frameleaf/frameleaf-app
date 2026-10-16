import { getPetCandidates, PetRecognitionRunStatus } from '@frameleaf/sdk';
import { render } from '@testing-library/svelte';
import { deferredPromise } from '@test-data/deferred';
import type { PageData } from './$types';
import PetsPage from './+page.svelte';

vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$lib/components/frameleaf/pets/PetCard.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/pets/PetRecognitionPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/pets/PetReviewPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/pets/MergePetsDialog.svelte', () => ({ default: () => {} }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), getPetCandidates: vi.fn() }));

type Candidates = Awaited<ReturnType<typeof getPetCandidates>>;
const running = {
  candidates: [],
  recognitionAvailable: true,
  recognition: { run: { status: PetRecognitionRunStatus.Running } },
} as unknown as Candidates;

afterEach(() => {
  vi.useRealTimers();
});

it('stops polling a recognition run once the page is gone, even with a poll in flight', async () => {
  vi.useFakeTimers();
  const inFlight = deferredPromise<Candidates>();
  vi.mocked(getPetCandidates).mockReturnValueOnce(inFlight.promise).mockResolvedValue(running);

  const view = render(PetsPage, {
    data: { pets: [], candidates: running, meta: { title: 'Pets' } } as unknown as PageData,
  });
  await vi.advanceTimersByTimeAsync(4000);
  expect(getPetCandidates).toHaveBeenCalledTimes(1);

  view.unmount();
  inFlight.resolve(running);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(getPetCandidates).toHaveBeenCalledTimes(1);
});
