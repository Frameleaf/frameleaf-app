import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { personFactory } from '@test-data/factories/person-factory';
import BirthdayDialog from './BirthdayDialog.svelte';

describe('BirthdayDialog (PD-5)', () => {
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

  it('refuses a date in the future', async () => {
    const person = personFactory.build({ name: 'Ada', birthDate: null });
    render(BirthdayDialog, { person, open: true });

    await fireEvent.input(screen.getByLabelText('Date of birth for Ada'), { target: { value: '2999-01-01' } });

    expect(screen.getByText('Choose a date that is not in the future.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes an existing date of birth', async () => {
    const person = personFactory.build({ name: 'Ada', birthDate: '1990-05-01' });
    sdkMock.updatePerson.mockResolvedValue({ ...person, birthDate: null });
    const onSaved = vi.fn();
    render(BirthdayDialog, { person, open: true, onSaved });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(sdkMock.updatePerson).toHaveBeenCalledWith({ id: person.id, personUpdateDto: { birthDate: null } });
  });
});
