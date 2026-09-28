import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { userAdminFactory } from '$lib/../test-data/factories/user-factory';
import AccountDeleteDialog from '$lib/components/frameleaf/AccountDeleteDialog.svelte';
import { handleDeleteUserAdmin } from '$lib/services/user-admin.service';
import en from '../../../../../i18n/en.json';

/** CC-32: as in the template (`AccountsLibraries.jsx` 632-659), deleting always asks for the typed email. */
vi.mock('$lib/services/user-admin.service', () => ({ handleDeleteUserAdmin: vi.fn().mockResolvedValue(true) }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { userDeleteDelay: 7 } },
}));

const user = userAdminFactory.build({ name: 'Grace Hopper', email: 'grace@example.test' });

beforeAll(() => {
  addMessages('dev', en);
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => vi.clearAllMocks());

describe('AccountDeleteDialog (FL-76 CC-32)', () => {
  it('asks for the typed email before the recoverable delete', async () => {
    render(AccountDeleteDialog, { user, onClose: vi.fn() });

    expect(screen.getByRole('dialog', { name: 'Delete account' })).toBeInTheDocument();
    expect(
      screen.getByText(/Grace Hopper will lose access\. Their account can be restored for 7 days/),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Delete account' });
    expect(submit).toBeDisabled();

    await fireEvent.input(screen.getByLabelText('Type the account email to confirm'), {
      target: { value: 'someone@example.test' },
    });
    expect(submit).toBeDisabled();
    await fireEvent.input(screen.getByLabelText('Type the account email to confirm'), {
      target: { value: 'Grace@Example.test ' },
    });
    expect(submit).toBeEnabled();
    await fireEvent.click(submit);

    expect(handleDeleteUserAdmin).toHaveBeenCalledWith(user, { force: false });
  });

  it('warns before skipping recovery and still needs the email', async () => {
    render(AccountDeleteDialog, { user, onClose: vi.fn() });

    await fireEvent.click(screen.getByRole('checkbox', { name: 'Skip recovery and permanently remove this account' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The account, its original photos and videos, and its owned library entries will be removed. This cannot be undone.',
    );
    const submit = screen.getByRole('button', { name: 'Permanently delete' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveClass('danger');

    await fireEvent.input(screen.getByLabelText('Type the account email to confirm'), {
      target: { value: 'grace@example.test' },
    });
    await fireEvent.click(submit);

    expect(handleDeleteUserAdmin).toHaveBeenCalledWith(user, { force: true });
  });
});
