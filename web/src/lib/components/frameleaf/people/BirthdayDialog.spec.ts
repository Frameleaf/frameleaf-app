import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { personFactory } from '@test-data/factories/person-factory';
import BirthdayDialog from './BirthdayDialog.svelte';

describe('BirthdayDialog (PD-5, FL-864)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  const field = (name: string) => within(screen.getByRole('group', { name }));
  const setDay = async (name: string, { day, month, year }: { day?: number; month?: number; year?: number }) => {
    const group = field(name);
    if (day !== undefined) {
      await fireEvent.input(group.getByLabelText('Day'), { target: { value: String(day) } });
    }
    if (month !== undefined)
      {await fireEvent.change(group.getByLabelText('Month'), { target: { value: String(month) } });}
    if (year !== undefined) {
      await fireEvent.input(group.getByLabelText('Year'), { target: { value: String(year) } });
    }
  };
  const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

  it('refuses a date in the future', async () => {
    const person = personFactory.build({ name: 'Ada', birthDate: null });
    render(BirthdayDialog, { person, open: true });

    await fireEvent.click(screen.getByRole('button', { name: 'Date of birth for Ada' }));
    await setDay('Date of birth for Ada', { day: 1, month: 1, year: 2999 });

    expect(save().disabled).toBe(true);
  });

  it('removes an existing date of birth', async () => {
    const person = personFactory.build({ name: 'Ada', birthDate: '1990-05-01' });
    sdkMock.updatePerson.mockResolvedValue({ ...person, birthDate: null });
    const onSaved = vi.fn();
    render(BirthdayDialog, { person, open: true, onSaved });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove dates' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.anything(), false));
    expect(sdkMock.updatePerson).toHaveBeenCalledWith({
      id: person.id,
      personUpdateDto: { birthDate: null, birthDatePrecision: null },
    });
  });

  it('adds a date of passing and sends only that date', async () => {
    const person = personFactory.build({ name: 'Ada', birthDate: '1938-04-02', deathDate: null });
    sdkMock.updatePerson.mockResolvedValue({ ...person, deathDate: '2021-10-09' });
    const onSaved = vi.fn();
    render(BirthdayDialog, { person, open: true, onSaved });

    expect(screen.queryByRole('group', { name: 'Date of passing (optional)' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Add a date of passing' }));

    await setDay('Date of passing (optional)', { day: 1, month: 4, year: 1938 });
    expect(screen.getByText('The date of passing can’t be before the date of birth.')).toBeTruthy();
    expect(save().disabled).toBe(true);

    await setDay('Date of passing (optional)', { day: 9, month: 10, year: 2021 });
    expect(screen.getByText(/Ada’s page shows 1938 – 2021 instead of an age/)).toBeTruthy();
    await fireEvent.click(save());

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.anything(), true));
    expect(sdkMock.updatePerson).toHaveBeenCalledWith({
      id: person.id,
      personUpdateDto: { deathDate: '2021-10-09', deathDatePrecision: null },
    });
  });

  it('takes the date of passing away again and keeps the date of birth', async () => {
    const person = personFactory.build({ name: 'Ada', birthDate: '1938-04-02', deathDate: '2021-10-09' });
    sdkMock.updatePerson.mockResolvedValue({ ...person, deathDate: null });
    const onSaved = vi.fn();
    render(BirthdayDialog, { person, open: true, onSaved });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove date of passing' }));
    await fireEvent.click(save());

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.anything(), true));
    expect(sdkMock.updatePerson).toHaveBeenCalledWith({
      id: person.id,
      personUpdateDto: { deathDate: null, deathDatePrecision: null },
    });
  });

  it('does not save a half-typed date', async () => {
    const person = personFactory.build({ name: 'Ada', birthDate: '1938-04-02', deathDate: '2021-10-09' });
    render(BirthdayDialog, { person, open: true });

    await fireEvent.input(field('Date of passing (optional)').getByLabelText('Year'), { target: { value: '' } });

    expect(save().disabled).toBe(true);
  });

  // FL-1814: how sure you are comes first
  it('saves "around 1950" as the start of that year with its precision, and reads it back', async () => {
    const person = personFactory.build({ name: 'Ada', birthDate: null });
    sdkMock.updatePerson.mockResolvedValue(person);
    render(BirthdayDialog, { person, open: true });

    await fireEvent.click(screen.getByRole('button', { name: 'Date of birth for Ada' }));
    const born = field('Date of birth for Ada');
    await fireEvent.change(born.getByLabelText('How sure are you?'), { target: { value: 'about' } });
    expect(born.queryByLabelText('Day')).toBeNull();
    expect(born.queryByLabelText('Month')).toBeNull();
    await fireEvent.input(born.getByLabelText('Year'), { target: { value: '1950' } });
    expect(born.getByText('Around 1950')).toBeTruthy();
    await fireEvent.click(save());

    await waitFor(() =>
      expect(sdkMock.updatePerson).toHaveBeenCalledWith({
        id: person.id,
        personUpdateDto: { birthDate: '1950-01-01', birthDatePrecision: 'about' },
      }),
    );
  });

  it('opens a month date as stored and saves nothing until something changes', async () => {
    const person = {
      ...personFactory.build({ name: 'Ada', birthDate: '1987-03-01' }),
      birthDatePrecision: 'month',
    };
    render(BirthdayDialog, { person, open: true });

    const born = field('Date of birth for Ada');
    expect((born.getByLabelText('How sure are you?') as HTMLSelectElement).value).toBe('month');
    expect(born.queryByLabelText('Day')).toBeNull();
    expect(save().disabled).toBe(true);
  });
});
