import { Field } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { emptyDraft } from '$lib/frameleaf/workflows';
import en from '../../../../../i18n/en.json';
import WorkflowAutomation from './WorkflowAutomation.svelte';

beforeEach(() => addMessages('dev', en));

it('keeps fixed dates until rolling capture dates are explicitly chosen', async () => {
  const source = {
    filter: { takenAt: { gte: '2026-01-01T00:00:00Z' } },
    rollingDates: [{ field: Field.CreatedAt, days: 7 }],
  };
  const onChange = vi.fn();
  render(WorkflowAutomation, {
    draft: { ...emptyDraft('AssetChanged'), source },
    timezone: 'America/Edmonton',
    onChange,
  });
  expect(screen.getByText(/2026-01-01T00:00:00Z/)).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_workflows.rolling_capture }));
  expect(onChange.mock.calls[0][0].source).toEqual({
    filter: {},
    rollingDates: [
      { field: 'createdAt', days: 7 },
      { field: 'takenAt', days: 30 },
    ],
  });
  expect(source.filter.takenAt.gte).toBe('2026-01-01T00:00:00Z');
});

const t = en.frameleaf_workflows;
const scheduled = (cron: string, onChange = vi.fn()) => {
  render(WorkflowAutomation, {
    draft: { ...emptyDraft('AssetChanged'), source: { filter: { rating: { gte: 4 } } }, schedule: { cron } },
    timezone: 'America/Edmonton',
    onChange,
  });
  return onChange;
};

/** FL-1815: "When it runs" says the schedule in words; the cron line is never on screen. */
describe('When it runs', () => {
  it('reads the choice back with the server’s place, and changes it without touching the search', async () => {
    const onChange = scheduled('15 9 * * *');
    expect(screen.getByRole('heading', { name: 'When it runs' })).toBeInTheDocument();
    expect(screen.getByText(/^Every day at 9:15/)).toBeInTheDocument();
    expect(screen.getByText(/Times are this server’s \(Edmonton\)\./)).toBeInTheDocument();
    expect(screen.queryByText(/cron/i)).toBeNull();
    expect(screen.queryByText('15 9 * * *')).toBeNull();

    const often = screen.getByRole('combobox', { name: t.frequency });
    expect([...often.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Every hour',
      'Every day',
      'Every week',
      'On chosen days',
    ]);
    await fireEvent.change(often, { target: { value: 'weekly' } });
    expect(onChange.mock.calls[0][0]).toMatchObject({
      source: { filter: { rating: { gte: 4 } } },
      schedule: { cron: '15 9 * * 1' },
    });
  });

  it('offers the weekday buttons for chosen days and never leaves a schedule without a day', async () => {
    const onChange = scheduled('0 9 * * 1,3');
    expect(screen.getByText(/^Monday and Wednesday at 9:00/)).toBeInTheDocument();
    const days = screen.getByRole('group', { name: t.days_group });
    expect(days.querySelectorAll('button')).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Friday' })).toHaveAttribute('aria-pressed', 'false');

    await fireEvent.click(screen.getByRole('button', { name: 'Friday' }));
    expect(onChange.mock.calls[0][0].schedule).toEqual({ cron: '0 9 * * 1,3,5' });
    await fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    expect(onChange.mock.calls[1][0].schedule).toEqual({ cron: '0 9 * * 1' });
  });

  it('keeps the last chosen day pressed', async () => {
    const onChange = vi.fn();
    const { rerender } = render(WorkflowAutomation, {
      draft: { ...emptyDraft('AssetChanged'), schedule: { cron: '0 9 * * 1,3' } },
      timezone: 'America/Edmonton',
      onChange,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    // one day is the same schedule as "every week": the picker stays on the days the person is choosing
    await rerender({ draft: { ...emptyDraft('AssetChanged'), schedule: { cron: '0 9 * * 1' } } });
    expect(screen.getByRole('combobox', { name: t.frequency })).toHaveValue('weekly');
    await fireEvent.change(screen.getByRole('combobox', { name: t.frequency }), { target: { value: 'days' } });
    await rerender({ draft: { ...emptyDraft('AssetChanged'), schedule: onChange.mock.lastCall![0].schedule } });
    expect(screen.getByRole('combobox', { name: t.frequency })).toHaveValue('days');
    onChange.mockClear();
    await fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('asks for minutes past the hour for an hourly schedule', async () => {
    const onChange = scheduled('5 * * * *');
    expect(screen.getByText('Every hour, at 5 minutes past.')).toBeInTheDocument();
    await fireEvent.change(screen.getByRole('spinbutton', { name: t.minutes_past }), { target: { value: '75' } });
    expect(onChange.mock.calls[0][0].schedule).toEqual({ cron: '59 * * * *' });
  });

  it('shows a schedule it cannot say as Custom schedule, leaves it alone, and can replace it', async () => {
    const onChange = scheduled('15 1,8 * * 1-5');
    expect(screen.getByText('Custom schedule.')).toBeInTheDocument();
    expect(screen.getByText(t.custom_body)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: t.frequency })).toBeNull();
    expect(screen.queryByText(/1,8/)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Replace with a simple schedule' }));
    expect(onChange.mock.calls[0][0].schedule).toEqual({ cron: '0 9 * * *' });
  });

  it('says the next run in the server’s time', () => {
    render(WorkflowAutomation, {
      draft: { ...emptyDraft('AssetChanged'), schedule: { cron: '0 9 * * *' } },
      timezone: 'Asia/Tokyo',
      nextRunAt: '2026-11-27T00:00:00.000Z',
      onChange: vi.fn(),
    });
    expect(screen.getByText(/Times are this server’s \(Tokyo\)\. Next run: .*27.*9:00/)).toBeInTheDocument();
  });

  it('uses the plain labels for the search the workflow came from', () => {
    scheduled('0 9 * * *');
    expect(screen.getByRole('heading', { name: 'Which photos and videos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change the search' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Only photos taken in the last 30 days' })).toBeInTheDocument();
  });
});
