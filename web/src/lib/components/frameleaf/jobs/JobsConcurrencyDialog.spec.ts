import type { AdminConfigDto } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import JobsConcurrencyDialog from '$lib/components/frameleaf/jobs/JobsConcurrencyDialog.svelte';
import { jobQueue, type JobQueueDefinition } from '$lib/frameleaf/job-queues';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../i18n/en.json';

const config = () =>
  ({
    job: {
      thumbnailGeneration: { concurrency: 3 },
      ocr: { concurrency: 1 },
    },
  }) as unknown as AdminConfigDto;

const store = () =>
  new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  );

const messages = en as unknown as Record<string, string>;
const title = (definition: JobQueueDefinition) => messages[`frameleaf_jobs_queue_${definition.key}`];

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  addMessages('dev', en);
});

describe('Queue concurrency dialog (FL-71, ConcurrencyDialog in JobsManager.jsx)', () => {
  it('edits a queue in the settings draft and marks it pending', async () => {
    const draft = store();
    render(JobsConcurrencyDialog, { open: true, store: draft, title });

    const dialog = screen.getByRole('dialog', { name: 'Queue concurrency' });
    const thumbnails = within(dialog).getByLabelText('Thumbnails simultaneous jobs');
    expect(thumbnails).toHaveValue(3);
    expect(within(dialog).getByText('Media · 3 currently saved')).toBeInTheDocument();

    await fireEvent.input(thumbnails, { target: { value: '6' } });

    expect(
      (draft.draft.job as unknown as Record<string, { concurrency: number }>).thumbnailGeneration.concurrency,
    ).toBe(6);
    expect(within(dialog).getByText('Pending')).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review 1 pending settings' }));
    expect(draft.reviewRequests).toBe(1);
  });

  it('keeps a pending value counted while its field is emptied, and holds the review until it is valid', async () => {
    const draft = store();
    render(JobsConcurrencyDialog, { open: true, store: draft, title });

    const thumbnails = screen.getByLabelText('Thumbnails simultaneous jobs');
    await fireEvent.input(thumbnails, { target: { value: '6' } });
    await fireEvent.input(thumbnails, { target: { value: '' } });

    expect(
      (draft.draft.job as unknown as Record<string, { concurrency: number }>).thumbnailGeneration.concurrency,
    ).toBe(6);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    // The review would save 6 while the field shows nothing, so it waits for a valid limit.
    expect(screen.queryByRole('button', { name: /pending settings/ })).toBeNull();

    await fireEvent.input(thumbnails, { target: { value: '7' } });
    expect(screen.getByRole('button', { name: 'Review 1 pending settings' })).toBeInTheDocument();
  });

  it('refuses a limit outside 1 to 1,000 without writing it', async () => {
    const draft = store();
    render(JobsConcurrencyDialog, { open: true, store: draft, title });

    const ocr = screen.getByLabelText('Text recognition simultaneous jobs');
    await fireEvent.input(ocr, { target: { value: '1001' } });

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 1,000.');
    expect(ocr).toHaveAttribute('aria-invalid', 'true');
    expect((draft.draft.job as unknown as Record<string, { concurrency: number }>).ocr.concurrency).toBe(1);
    expect(screen.queryByRole('button', { name: /pending settings/ })).toBeNull();
  });

  it('shows the queues the server runs one at a time as fixed, and finds a queue by name', async () => {
    render(JobsConcurrencyDialog, { open: true, store: store(), title });

    const recognition = screen.getByLabelText(`${title(jobQueue('facialRecognition' as never)!)} simultaneous jobs`);
    expect(recognition).toBeDisabled();
    expect(screen.getAllByText('Fixed at one to keep operations ordered').length).toBeGreaterThan(0);

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find queue concurrency' }), {
      target: { value: 'text' },
    });
    expect(screen.getByLabelText('Text recognition simultaneous jobs')).toBeInTheDocument();
    expect(screen.queryByLabelText('Thumbnails simultaneous jobs')).toBeNull();
  });
});
