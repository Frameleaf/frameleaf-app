import type { AuthStatusResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import TwoStepSection from '$lib/components/frameleaf/access/TwoStepSection.svelte';
import TwoStepMoveDialog from '$lib/components/frameleaf/access/two-step/TwoStepMoveDialog.svelte';
import TwoStepNewCodesDialog from '$lib/components/frameleaf/access/two-step/TwoStepNewCodesDialog.svelte';
import TwoStepSetupDialog from '$lib/components/frameleaf/access/two-step/TwoStepSetupDialog.svelte';
import TwoStepTurnOffDialog from '$lib/components/frameleaf/access/two-step/TwoStepTurnOffDialog.svelte';

const modal = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@frameleaf/ui', async (original) => ({
  ...(await original<typeof import('@frameleaf/ui')>()),
  modalManager: modal,
}));

const status = (extra: Partial<AuthStatusResponseDto> = {}): AuthStatusResponseDto => ({
  pinCode: true,
  password: true,
  isElevated: false,
  twoFactorEnabled: false,
  recoveryCodesRemaining: 0,
  passkeysAvailable: true,
  hasPasskeys: false,
  ...extra,
});
const httpError = (status: number, data: Record<string, unknown>) => ({ status, data });
const typeInto = (element: HTMLElement, value: string) => fireEvent.input(element, { target: { value } });
const lastButton = (name: string) => screen.getAllByRole('button', { name }).at(-1)!;
const CODES = ['h7k2m-xq4rt', 'p9wfn-3cd8a', 'teg5v-kz2hy', '4nbqr-w7mps', 'c8yxd-fu3ke'];

beforeEach(() => {
  vi.resetAllMocks();
  sdkMock.isHttpError.mockImplementation((error: unknown) => !!error && typeof error === 'object' && 'status' in error);
});

describe('Two-step sign-in page (FL-831)', () => {
  it('opens on "off" with what you need, and Turn on opens the setup', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(status());
    modal.show.mockResolvedValue(true);
    render(TwoStepSection);

    expect(await screen.findByRole('heading', { name: 'frameleaf_two_step_hero_off' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_two_step_need_title')).toBeInTheDocument();
    expect(screen.queryByText('frameleaf_two_step_yours')).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_two_step_turn_on_open' }));
    expect(modal.show).toHaveBeenCalledWith(TwoStepSetupDialog, {});
    expect(await screen.findByText('frameleaf_two_step_on_said')).toBeInTheDocument();
    expect(sdkMock.getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('when on, offers moving phones, new codes and turning off, and says how many codes are left', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(status({ twoFactorEnabled: true, recoveryCodesRemaining: 8 }));
    modal.show.mockResolvedValue(false);
    render(TwoStepSection);

    expect(await screen.findByRole('heading', { name: 'frameleaf_two_step_hero_on' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_two_step_codes_help')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_two_step_move_open' }));
    expect(modal.show).toHaveBeenLastCalledWith(TwoStepMoveDialog, {});
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_two_step_codes_open' }));
    expect(modal.show).toHaveBeenLastCalledWith(TwoStepNewCodesDialog, {});
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_two_step_title' }));
    expect(modal.show).toHaveBeenLastCalledWith(TwoStepTurnOffDialog, {});
  });

  it('warns when one recovery code or none is left', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(status({ twoFactorEnabled: true, recoveryCodesRemaining: 1 }));
    render(TwoStepSection);
    expect(await screen.findByRole('heading', { name: 'frameleaf_two_step_hero_low' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_two_step_make_codes_open' })).toBeInTheDocument();
  });

  it('says it needs a password on an account without one', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(status({ password: false }));
    render(TwoStepSection);
    expect(await screen.findByRole('heading', { name: 'frameleaf_two_step_hero_no_password' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'frameleaf_two_step_turn_on_open' })).not.toBeInTheDocument();
  });

  it('offers to try again when the status could not be read', async () => {
    sdkMock.getAuthStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(status());
    render(TwoStepSection);
    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_two_step_try_again' }));
    expect(await screen.findByRole('heading', { name: 'frameleaf_two_step_hero_off' })).toBeInTheDocument();
  });
});

describe('Turn on two-step sign-in (FL-831)', () => {
  it('goes password, scan, code, then shows the recovery codes once with Done after "I saved them"', async () => {
    sdkMock.setupTwoFactor.mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/Frameleaf:taylor%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Frameleaf',
    });
    sdkMock.enableTwoFactor
      .mockRejectedValueOnce(httpError(400, { message: 'That code didn’t work.' }))
      .mockResolvedValue({ recoveryCodes: CODES });
    const onClose = vi.fn();
    render(TwoStepSetupDialog, { onClose });

    expect(screen.getByText('frameleaf_two_step_step')).toBeInTheDocument();
    await typeInto(screen.getByLabelText(/frameleaf_two_step_password/), 'correct horse');
    await fireEvent.click(lastButton('frameleaf_two_step_continue'));
    await waitFor(() =>
      expect(sdkMock.setupTwoFactor).toHaveBeenCalledWith({ twoFactorPasswordDto: { password: 'correct horse' } }),
    );

    // Step 2: the QR code and the key in fours
    expect(await screen.findByRole('img', { name: 'frameleaf_two_step_qr_label' })).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    await fireEvent.click(lastButton('frameleaf_two_step_added'));

    // Step 3: a wrong code is said beside the field; spaces from a paste go
    const field = screen.getByLabelText('frameleaf_two_step_app_code_label');
    await typeInto(field, '123 456');
    await fireEvent.click(lastButton('frameleaf_two_step_turn_on'));
    expect(await screen.findByText('frameleaf_two_step_confirm_wrong')).toBeInTheDocument();
    expect(sdkMock.enableTwoFactor).toHaveBeenCalledWith({ twoFactorCodeDto: { code: '123456' } });

    await typeInto(screen.getByLabelText('frameleaf_two_step_app_code_label'), '654321');
    await fireEvent.click(lastButton('frameleaf_two_step_turn_on'));

    // Step 4: the codes, Download and Print, and Done only after "I saved them"
    for (const code of CODES) {
      expect(await screen.findByText(code)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'frameleaf_two_step_download' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_two_step_print' })).toBeInTheDocument();
    expect(lastButton('frameleaf_two_step_done')).toBeDisabled();
    await fireEvent.click(screen.getByRole('checkbox', { name: /frameleaf_two_step_saved/ }));
    expect(lastButton('frameleaf_two_step_done')).toBeEnabled();
  });

  it('says a wrong password and a wait from the server', async () => {
    sdkMock.setupTwoFactor
      .mockRejectedValueOnce(httpError(400, { message: 'Wrong password' }))
      .mockRejectedValueOnce(httpError(429, { message: 'Too many requests.', retryAfter: 170 }));
    render(TwoStepSetupDialog, { onClose: vi.fn() });

    await typeInto(screen.getByLabelText(/frameleaf_two_step_password/), 'nope');
    await fireEvent.click(lastButton('frameleaf_two_step_continue'));
    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
    await fireEvent.click(lastButton('frameleaf_two_step_continue'));
    expect(await screen.findByText('frameleaf_two_step_wait')).toBeInTheDocument();
  });
});

describe('Make new recovery codes, turn off, move (FL-831)', () => {
  it('makes new codes behind the password and shows them once', async () => {
    sdkMock.regenerateRecoveryCodes.mockResolvedValue({ recoveryCodes: CODES });
    render(TwoStepNewCodesDialog, { onClose: vi.fn() });
    await typeInto(screen.getByLabelText(/frameleaf_two_step_password/), 'correct horse');
    await fireEvent.click(lastButton('frameleaf_two_step_new_make'));
    expect(await screen.findByText(CODES[0])).toBeInTheDocument();
    expect(sdkMock.regenerateRecoveryCodes).toHaveBeenCalledWith({
      twoFactorPasswordDto: { password: 'correct horse' },
    });
  });

  it('turns off with the password and a recovery code', async () => {
    sdkMock.disableTwoFactor.mockResolvedValue(undefined as never);
    const onClose = vi.fn();
    render(TwoStepTurnOffDialog, { onClose });

    expect(lastButton('frameleaf_two_step_turn_off')).toBeDisabled();
    await typeInto(screen.getByLabelText(/frameleaf_two_step_password/), 'correct horse');
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_two_step_off_use_recovery' }));
    await typeInto(screen.getByLabelText('frameleaf_two_step_recovery_label'), 'H7K2M XQ4RT');
    await fireEvent.click(lastButton('frameleaf_two_step_turn_off'));

    await waitFor(() =>
      expect(sdkMock.disableTwoFactor).toHaveBeenCalledWith({
        twoFactorProofDto: { password: 'correct horse', recoveryCode: 'h7k2m-xq4rt' },
      }),
    );
  });

  it('moves to a new phone: old code, scan, new code', async () => {
    sdkMock.startTwoFactorMove.mockResolvedValue({ secret: 'KRSXG5CTMVRXEZLU', otpauthUri: 'otpauth://totp/x' });
    sdkMock.confirmTwoFactorMove
      .mockRejectedValueOnce(httpError(400, { message: 'That code didn’t work.' }))
      .mockResolvedValue(undefined as never);
    render(TwoStepMoveDialog, { onClose: vi.fn() });

    await typeInto(screen.getByLabelText(/frameleaf_two_step_password/), 'correct horse');
    await typeInto(screen.getByLabelText('frameleaf_two_step_app_code_label'), '111111');
    await fireEvent.click(lastButton('frameleaf_two_step_continue'));
    await waitFor(() =>
      expect(sdkMock.startTwoFactorMove).toHaveBeenCalledWith({
        twoFactorProofDto: { password: 'correct horse', code: '111111' },
      }),
    );
    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_two_step_added' }));
    await typeInto(screen.getByLabelText('frameleaf_two_step_app_code_label'), '222222');
    await fireEvent.click(lastButton('frameleaf_two_step_move_finish'));
    expect(await screen.findByText('frameleaf_two_step_move_wrong')).toBeInTheDocument();
    await typeInto(screen.getByLabelText('frameleaf_two_step_app_code_label'), '333333');
    await fireEvent.click(lastButton('frameleaf_two_step_move_finish'));
    await waitFor(() =>
      expect(sdkMock.confirmTwoFactorMove).toHaveBeenLastCalledWith({ twoFactorCodeDto: { code: '333333' } }),
    );
  });
});
