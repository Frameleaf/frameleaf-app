import { MaintenanceAction } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import MaintenanceModeCard from './MaintenanceModeCard.svelte';

const handleSetMaintenanceMode = vi.fn();

vi.mock('$lib/services/maintenance.service', () => ({
  handleSetMaintenanceMode: (...args: unknown[]) => handleSetMaintenanceMode(...args),
}));

describe('MaintenanceModeCard (FL-81 CC-14/15/16)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    handleSetMaintenanceMode.mockReset();
    handleSetMaintenanceMode.mockResolvedValue(undefined);
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
  });

  it('shows the prototype status pill, facts, preview and section links', () => {
    render(MaintenanceModeCard, { backupsHref: '/b', integrityHref: '/i' });

    expect(screen.getByRole('heading', { name: 'Maintenance mode' })).toBeInTheDocument();
    expect(screen.getAllByText('Off')).toHaveLength(2);
    expect(screen.getByText('Administrators')).toBeInTheDocument();
    expect(screen.getByText('Everyone else')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'What people see during maintenance' })).toHaveTextContent(
      'Frameleaf is being looked after',
    );
    expect(screen.getByRole('link', { name: 'Database backups' })).toHaveAttribute('href', '/b');
    expect(screen.getByRole('link', { name: 'Integrity checks' })).toHaveAttribute('href', '/i');
  });

  it('shows the reason while maintenance is on', () => {
    render(MaintenanceModeCard, {
      status: { active: true, action: MaintenanceAction.Start, reason: 'Replacing the library disk' },
    });
    expect(screen.getAllByText('On')).toHaveLength(2);
    expect(screen.getByText('Replacing the library disk')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start maintenance' })).not.toBeInTheDocument();
  });

  it('starts maintenance with the optional reason from the start dialog', async () => {
    render(MaintenanceModeCard);

    await fireEvent.click(screen.getByRole('button', { name: 'Start maintenance' }));
    const reason = screen.getByLabelText('Reason shown on the maintenance page (optional)');
    expect(reason).toHaveAttribute('maxlength', '200');
    await fireEvent.input(reason, { target: { value: '  Replacing the library disk  ' } });
    const buttons = screen.getAllByRole('button', { name: 'Start maintenance' });
    await fireEvent.click(buttons.at(-1)!);

    expect(handleSetMaintenanceMode).toHaveBeenCalledWith({
      action: MaintenanceAction.Start,
      reason: 'Replacing the library disk',
    });
  });

  it('omits a blank reason', async () => {
    render(MaintenanceModeCard);

    await fireEvent.click(screen.getByRole('button', { name: 'Start maintenance' }));
    const buttons = screen.getAllByRole('button', { name: 'Start maintenance' });
    await fireEvent.click(buttons.at(-1)!);

    expect(handleSetMaintenanceMode).toHaveBeenCalledWith({ action: MaintenanceAction.Start });
  });
});
