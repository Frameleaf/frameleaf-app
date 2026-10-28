import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { Field } from '@frameleaf/sdk';
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

it('shows the server timezone and edits schedule presets without changing source conditions', async () => {
  const onChange = vi.fn();
  render(WorkflowAutomation, {
    draft: {
      ...emptyDraft('AssetChanged'),
      source: { filter: { rating: { gte: 4 } } },
      schedule: { cron: '15 9 * * *' },
    },
    timezone: 'America/Edmonton',
    onChange,
  });
  expect(screen.getByText('Server timezone: America/Edmonton')).toBeInTheDocument();
  await fireEvent.change(screen.getByRole('combobox', { name: en.frameleaf_workflows.frequency }), {
    target: { value: 'weekly' },
  });
  expect(onChange.mock.calls[0][0]).toMatchObject({
    source: { filter: { rating: { gte: 4 } } },
    schedule: { cron: '15 9 * * 1' },
  });
});
