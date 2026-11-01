import { LockedEncryptionMode, LockedEncryptionState, type LockedEncryptionStatusResponseDto } from '@frameleaf/sdk';
import { modalManager, toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LockedEncryptionPage from '$lib/components/frameleaf/settings/security/locked-encryption/LockedEncryptionPage.svelte';
import LockedKeyCheck from '$lib/components/frameleaf/settings/security/locked-encryption/LockedKeyCheck.svelte';
import PartnerLockedItemState from '$lib/components/frameleaf/settings/security/locked-encryption/PartnerLockedItemState.svelte';
import PassphraseModal from '$lib/components/frameleaf/settings/security/locked-encryption/PassphraseModal.svelte';
import TurnOffModal from '$lib/components/frameleaf/settings/security/locked-encryption/TurnOffModal.svelte';
import TurnOnModal from '$lib/components/frameleaf/settings/security/locked-encryption/TurnOnModal.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../../../../i18n/en.json';

const RECOVERY_KEY = 'FLRK-7Q4M-K2XD-93VA-PL6E-W8HC-4JNT-RB5Z';

const status = (overrides: Partial<LockedEncryptionStatusResponseDto> = {}): LockedEncryptionStatusResponseDto => ({
  enabled: false,
  mode: null,
  status: null,
  keyLoaded: false,
  expiresAt: null,
  askAgainHours: 72,
  recoveryKeyCreatedAt: null,
  progress: null,
  counts: { encrypted: 0, notEncryptable: 0, missing: 0 },
  ...overrides,
});

const on = (overrides: Partial<LockedEncryptionStatusResponseDto> = {}) =>
  status({
    enabled: true,
    mode: LockedEncryptionMode.Pin,
    status: LockedEncryptionState.On,
    keyLoaded: true,
    recoveryKeyCreatedAt: '2026-10-31T12:00:00.000Z',
    counts: { encrypted: 223, notEncryptable: 0, missing: 0 },
    ...overrides,
  });

const typeInto = (element: HTMLElement, value: string) => fireEvent.input(element, { target: { value } });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
/** What the SDK throws for a 423: an error with the status and the parsed body. */
const locked = (data: Record<string, unknown>) =>
  Object.assign(new Error('Locked'), { status: 423, data: { code: 'locked_key_unavailable', ...data } });

describe('Locked encryption (FL-721)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(userAdminFactory.build({ name: 'Taylor' }));
    sdkMock.getAuthStatus.mockResolvedValue({ pinCode: true, isElevated: true } as never);
  });

  describe('the settings page', () => {
    it('off state shows "Your Locked files aren’t encrypted" and Turn on…', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(status());
      render(LockedEncryptionPage);

      expect(await screen.findByRole('heading', { name: 'Your Locked files aren’t encrypted' })).toBeInTheDocument();
      expect(button('Turn on…')).toBeEnabled();
      expect(screen.getByText('Photos you add to Locked later are encrypted as they arrive.')).toBeInTheDocument();
    });

    it('needs state: Unlock calls unlockLockedEncryption', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(on({ mode: LockedEncryptionMode.Advanced, keyLoaded: false }));
      sdkMock.unlockLockedEncryption.mockResolvedValue(undefined as never);
      render(LockedEncryptionPage);

      expect(await screen.findByRole('heading', { name: 'Type your passphrase to open Locked' })).toBeInTheDocument();
      await typeInto(screen.getByLabelText('Passphrase'), 'correct horse battery');
      await fireEvent.click(button('Unlock'));

      await waitFor(() =>
        expect(sdkMock.unlockLockedEncryption).toHaveBeenCalledWith({
          lockedEncryptionUnlockDto: { passphrase: 'correct horse battery' },
        }),
      );
    });

    it('status decrypting without a loaded key shows "Type your PIN to finish turning off encryption", and submitting resumes', async () => {
      sdkMock.getLockedEncryption.mockResolvedValueOnce(
        on({ status: LockedEncryptionState.Decrypting, keyLoaded: false, progress: { done: 3, total: 10 } }),
      );
      sdkMock.getLockedEncryption.mockResolvedValue(
        on({ status: LockedEncryptionState.Decrypting, keyLoaded: true, progress: { done: 3, total: 10 } }),
      );
      sdkMock.unlockAuthSession.mockResolvedValue(undefined as never);
      render(LockedEncryptionPage);

      expect(
        await screen.findByRole('heading', { name: 'Type your PIN to finish turning off encryption' }),
      ).toBeInTheDocument();
      await typeInto(screen.getByLabelText('Locked PIN'), '123456');
      await fireEvent.click(button('Unlock'));

      await waitFor(() =>
        expect(sdkMock.unlockAuthSession).toHaveBeenCalledWith({ sessionUnlockDto: { pinCode: '123456' } }),
      );
      expect(await screen.findByRole('heading', { name: 'Decrypting your Locked files' })).toBeInTheDocument();
    });

    it('status decrypting without a loaded key asks for the passphrase in Advanced Security', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(
        on({ mode: LockedEncryptionMode.Advanced, status: LockedEncryptionState.Decrypting, keyLoaded: false }),
      );
      sdkMock.unlockLockedEncryption.mockResolvedValue(undefined as never);
      render(LockedEncryptionPage);

      expect(
        await screen.findByRole('heading', { name: 'Type your passphrase to finish turning off encryption' }),
      ).toBeInTheDocument();
      await typeInto(screen.getByLabelText('Passphrase'), 'correct horse battery');
      await fireEvent.click(button('Unlock'));
      await waitFor(() => expect(sdkMock.unlockLockedEncryption).toHaveBeenCalled());
    });

    it('says when turning off waits on missing files', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(
        on({
          status: LockedEncryptionState.Decrypting,
          progress: { done: 8, total: 10 },
          counts: { encrypted: 2, notEncryptable: 0, missing: 2 },
        }),
      );
      render(LockedEncryptionPage);

      expect(await screen.findByText('2 Locked items are missing their files')).toBeInTheDocument();
    });

    it('says how many Locked items a partner shared stay unencrypted (I3)', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(
        on({ counts: { encrypted: 223, notEncryptable: 0, missing: 0, sharedNotEncrypted: 40 } }),
      );
      render(LockedEncryptionPage);

      expect(
        await screen.findByText('40 items shared with you by a partner aren’t encrypted by your setting.'),
      ).toBeInTheDocument();
    });

    it('says nothing about partner items when there are none', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(on());
      render(LockedEncryptionPage);

      expect(await screen.findByRole('button', { name: /Turn off/ })).toBeInTheDocument();
      expect(screen.queryByText(/shared with you by a partner/)).not.toBeInTheDocument();
    });
  });

  describe('the ask-again time (N2)', () => {
    const advancedOn = () =>
      on({ mode: LockedEncryptionMode.Advanced, askAgainHours: 8, expiresAt: '2026-11-01T20:00:00.000Z' });
    const pressed = (name: string) => expect(button(name)).toHaveAttribute('aria-pressed', 'true');

    it('keeping Locked open longer asks for the passphrase first and sends it', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(advancedOn());
      sdkMock.updateLockedEncryption.mockResolvedValue(undefined as never);
      render(LockedEncryptionPage);

      await fireEvent.click(await screen.findByRole('button', { name: '72 hours' }));
      expect(
        await screen.findByRole('heading', { name: 'Type your passphrase to keep Locked open longer' }),
      ).toBeInTheDocument();
      expect(sdkMock.updateLockedEncryption).not.toHaveBeenCalled();

      await typeInto(screen.getByLabelText('Passphrase'), 'correct horse battery');
      await fireEvent.click(button('Keep open longer'));

      await waitFor(() =>
        expect(sdkMock.updateLockedEncryption).toHaveBeenCalledWith({
          lockedEncryptionUpdateDto: { askAgainHours: 72, currentSecret: 'correct horse battery' },
        }),
      );
    });

    it('cancelling the passphrase changes nothing and the choice snaps back', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(advancedOn());
      render(LockedEncryptionPage);

      await fireEvent.click(await screen.findByRole('button', { name: 'Only after a restart' }));
      await screen.findByRole('heading', { name: 'Type your passphrase to keep Locked open longer' });
      await fireEvent.click(button('Cancel'));

      await waitFor(() => pressed('8 hours'));
      expect(button('Only after a restart')).toHaveAttribute('aria-pressed', 'false');
      expect(sdkMock.updateLockedEncryption).not.toHaveBeenCalled();
      expect(sdkMock.getLockedEncryption).toHaveBeenCalledTimes(2);
    });

    it('a wrong passphrase says so in plain words and the choice snaps back', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue(advancedOn());
      sdkMock.updateLockedEncryption.mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { status: 401, data: { message: 'Wrong passphrase' } }),
      );
      render(LockedEncryptionPage);

      await fireEvent.click(await screen.findByRole('button', { name: '24 hours' }));
      await typeInto(await screen.findByLabelText('Passphrase'), 'not it');
      await fireEvent.click(button('Keep open longer'));

      expect(
        await screen.findByText('That passphrase didn’t work, so Locked still asks for it again after 8 hours.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('Wrong passphrase')).not.toBeInTheDocument();
      await waitFor(() => pressed('8 hours'));
    });

    it('a shorter time needs no passphrase', async () => {
      sdkMock.getLockedEncryption.mockResolvedValue({ ...advancedOn(), askAgainHours: 72 });
      sdkMock.updateLockedEncryption.mockResolvedValue(undefined as never);
      render(LockedEncryptionPage);

      await fireEvent.click(await screen.findByRole('button', { name: '8 hours' }));

      await waitFor(() =>
        expect(sdkMock.updateLockedEncryption).toHaveBeenCalledWith({
          lockedEncryptionUpdateDto: { askAgainHours: 8 },
        }),
      );
      expect(screen.queryByRole('heading', { name: 'Type your passphrase to keep Locked open longer' })).toBeNull();
    });
  });

  describe('turning on', () => {
    const renderTurnOn = () => {
      const onClose = vi.fn();
      render(TurnOnModal, { onClose });
      return onClose;
    };

    it('turn-on Continue stays disabled until both acknowledgement boxes are ticked', async () => {
      renderTurnOn();
      await fireEvent.click(button('Continue'));
      expect(screen.getByRole('heading', { name: 'Before you encrypt' })).toBeInTheDocument();

      const proceed = button('I understand, continue');
      expect(proceed).toBeDisabled();
      await fireEvent.click(
        screen.getByLabelText('I understand that losing my PIN and recovery key means losing these photos'),
      );
      expect(proceed).toBeDisabled();
      await fireEvent.click(screen.getByLabelText('I understand an administrator can’t reset my PIN while this is on'));
      expect(proceed).toBeEnabled();
    });

    it('the advanced passphrase step requires 12+ characters and a match', async () => {
      renderTurnOn();
      await fireEvent.click(screen.getByLabelText(/Advanced Security: add a passphrase/));
      await fireEvent.click(button('Continue'));
      expect(screen.getByRole('heading', { name: 'Choose a passphrase' })).toBeInTheDocument();

      const proceed = button('Continue');
      await typeInto(screen.getByLabelText('Passphrase'), 'too short');
      await typeInto(screen.getByLabelText('Type the passphrase again'), 'too short');
      expect(proceed).toBeDisabled();
      expect(screen.getByText('3 more characters.')).toBeInTheDocument();

      await typeInto(screen.getByLabelText('Passphrase'), 'correct horse battery');
      await typeInto(screen.getByLabelText('Type the passphrase again'), 'correct horse batterz');
      expect(proceed).toBeDisabled();

      await typeInto(screen.getByLabelText('Type the passphrase again'), 'correct horse battery');
      expect(proceed).toBeEnabled();
    });

    const toConfirm = async () => {
      await fireEvent.click(button('Continue'));
      await fireEvent.click(
        screen.getByLabelText('I understand that losing my PIN and recovery key means losing these photos'),
      );
      await fireEvent.click(screen.getByLabelText('I understand an administrator can’t reset my PIN while this is on'));
      await fireEvent.click(button('I understand, continue'));
    };

    it('the confirm step calls enableLockedEncryption with mode and PIN', async () => {
      sdkMock.enableLockedEncryption.mockResolvedValue({ recoveryKey: RECOVERY_KEY });
      renderTurnOn();
      await toConfirm();

      await typeInto(screen.getByLabelText('Locked PIN'), '123456');
      await fireEvent.click(button('Encrypt now'));

      await waitFor(() =>
        expect(sdkMock.enableLockedEncryption).toHaveBeenCalledWith({
          lockedEncryptionEnableDto: { mode: LockedEncryptionMode.Pin, pinCode: '123456' },
        }),
      );
    });

    it('recovery step: Continue is disabled until "I’ve saved my recovery key…" is ticked, and Download creates frameleaf-recovery-key-<name>.txt containing the key', async () => {
      sdkMock.enableLockedEncryption.mockResolvedValue({ recoveryKey: RECOVERY_KEY });
      const blobs: Blob[] = [];
      const createObjectURL = vi.fn((blob: Blob | MediaSource) => {
        blobs.push(blob as Blob);
        return 'blob:recovery';
      });
      // jsdom has no object URLs: put stand-ins on the real `URL` for this test only, then take them away
      const hadObjectUrls = 'createObjectURL' in URL;
      if (!hadObjectUrls) {
        Object.assign(URL, { createObjectURL: () => '', revokeObjectURL: () => {} });
      }
      const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const downloads: string[] = [];
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloads.push(this.download);
      });

      const onClose = renderTurnOn();
      await toConfirm();
      await typeInto(screen.getByLabelText('Locked PIN'), '123456');
      await fireEvent.click(button('Encrypt now'));

      expect(await screen.findByRole('heading', { name: 'Save your recovery key' })).toBeInTheDocument();
      expect(screen.getByText(RECOVERY_KEY)).toBeInTheDocument();
      const proceed = button('Continue');
      expect(proceed).toBeDisabled();

      await fireEvent.click(button('Download'));
      expect(downloads).toEqual(['frameleaf-recovery-key-taylor.txt']);
      expect(await blobs[0].text()).toContain(RECOVERY_KEY);

      await fireEvent.click(screen.getByLabelText('I’ve saved my recovery key somewhere other than this server'));
      expect(proceed).toBeEnabled();
      await fireEvent.click(proceed);
      await waitFor(() => expect(onClose).toHaveBeenCalledWith({ mode: LockedEncryptionMode.Pin }));
      click.mockRestore();
      create.mockRestore();
      revoke.mockRestore();
      if (!hadObjectUrls) {
        Reflect.deleteProperty(URL, 'createObjectURL');
        Reflect.deleteProperty(URL, 'revokeObjectURL');
      }
    });
  });

  describe('turning off', () => {
    it('the turn-off second step calls disableLockedEncryption', async () => {
      sdkMock.disableLockedEncryption.mockResolvedValue(undefined as never);
      const onClose = vi.fn();
      render(TurnOffModal, { mode: LockedEncryptionMode.Pin, onClose });

      expect(screen.getByRole('heading', { name: 'Turn off Locked encryption?' })).toBeInTheDocument();
      expect(button('Continue')).toBeDisabled();
      await fireEvent.click(screen.getByLabelText('I understand my Locked files won’t be encrypted any more'));
      await fireEvent.click(button('Continue'));

      await typeInto(screen.getByLabelText('Locked PIN'), '123456');
      await fireEvent.click(button('Decrypt and turn off'));

      await waitFor(() =>
        expect(sdkMock.disableLockedEncryption).toHaveBeenCalledWith({
          lockedEncryptionDisableDto: { pinCode: '123456' },
        }),
      );
      await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    });
  });

  describe('the passphrase prompt', () => {
    it('a partner’s variant asks for the owner’s passphrase and calls partner-unlock', async () => {
      sdkMock.unlockPartnerLockedEncryption.mockResolvedValue(undefined as never);
      const onClose = vi.fn();
      render(PassphraseModal, { kind: 'partner', ownerId: 'owner-1', ownerName: 'Morgan', onClose });

      expect(screen.getByRole('heading', { name: 'Type Morgan’s passphrase' })).toBeInTheDocument();
      await typeInto(screen.getByLabelText('Passphrase'), 'morgan passphrase');
      await fireEvent.click(button('Unlock'));

      await waitFor(() =>
        expect(sdkMock.unlockPartnerLockedEncryption).toHaveBeenCalledWith({
          lockedEncryptionPartnerUnlockDto: { ownerId: 'owner-1', passphrase: 'morgan passphrase' },
        }),
      );
      await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    });

    it('a partner’s item waiting on its owner says so, without a prompt', () => {
      render(PartnerLockedItemState, {
        lockedEncryption: { openable: false, reason: 'not-ready' as never, ownerName: 'Morgan' },
        ownerId: 'owner-1',
        onOpened: vi.fn(),
      });
      expect(screen.getByRole('heading', { name: 'Not ready yet' })).toBeInTheDocument();
      expect(screen.getByText('Opens after Morgan next opens Locked.')).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('a partner’s Advanced Security item offers the owner’s passphrase prompt', async () => {
      const show = vi.spyOn(modalManager, 'show').mockResolvedValue(true as never);
      const onOpened = vi.fn();
      render(PartnerLockedItemState, {
        lockedEncryption: { openable: false, reason: 'owner-passphrase' as never, ownerName: 'Morgan' },
        ownerId: 'owner-1',
        onOpened,
      });
      await fireEvent.click(button('Type Morgan’s passphrase…'));
      expect(show).toHaveBeenCalledWith(PassphraseModal, { kind: 'partner', ownerId: 'owner-1', ownerName: 'Morgan' });
      await waitFor(() => expect(onOpened).toHaveBeenCalled());
      show.mockRestore();
    });

    describe('a 423 is never silent', () => {
      let show: ReturnType<typeof vi.spyOn>;
      let primary: ReturnType<typeof vi.spyOn>;
      let danger: ReturnType<typeof vi.spyOn>;
      let info: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        // handleError logs every error it handles
        vi.spyOn(console, 'error').mockImplementation(() => {});
        show = vi.spyOn(modalManager, 'show').mockResolvedValue(true as never);
        primary = vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
        danger = vi.spyOn(toastManager, 'danger').mockImplementation(() => {});
        info = vi.spyOn(toastManager, 'info').mockImplementation(() => {});
      });
      afterEach(() => vi.restoreAllMocks());

      const refuse = () =>
        handleError(locked({ mode: 'advanced', message: 'Type your passphrase first' }), 'Couldn’t unlock');

      it('a 423 on the Locked page opens PassphraseModal, and once it opens says to try again', async () => {
        sdkMock.getLockedEncryption.mockResolvedValue(on({ mode: LockedEncryptionMode.Advanced, keyLoaded: false }));

        // an action on the Locked page (Unlock an item) refused because the key isn't open
        refuse();
        await waitFor(() =>
          expect(show).toHaveBeenCalledWith(PassphraseModal, expect.objectContaining({ kind: 'own' })),
        );
        await waitFor(() => expect(primary).toHaveBeenCalledWith('Unlocked. Try that again.'));
        expect(danger).not.toHaveBeenCalled();

        // and the Locked page itself, opened after a restart, asks at once
        show.mockClear();
        const onUnlocked = vi.fn();
        render(LockedKeyCheck, { onUnlocked });
        await waitFor(() =>
          expect(show).toHaveBeenCalledWith(PassphraseModal, expect.objectContaining({ kind: 'own' })),
        );
        await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
      });

      it('shows the action’s own error when the prompt is dismissed', async () => {
        sdkMock.getLockedEncryption.mockResolvedValue(on({ mode: LockedEncryptionMode.Advanced, keyLoaded: false }));
        show.mockResolvedValue(false as never);
        refuse();
        await waitFor(() => expect(danger).toHaveBeenCalledWith('Couldn’t unlock'));
        expect(primary).not.toHaveBeenCalled();
      });

      it('shows the action’s own error when the status can’t be read', async () => {
        sdkMock.getLockedEncryption.mockRejectedValue(new Error('offline'));
        refuse();
        await waitFor(() => expect(danger).toHaveBeenCalledWith('Couldn’t unlock'));
        expect(show).not.toHaveBeenCalled();
      });

      it('shows the action’s own error when the key is already open or encryption is off', async () => {
        sdkMock.getLockedEncryption.mockResolvedValue(on({ mode: LockedEncryptionMode.Advanced, keyLoaded: true }));
        refuse();
        await waitFor(() => expect(danger).toHaveBeenCalledTimes(1));

        sdkMock.getLockedEncryption.mockResolvedValue(status());
        refuse();
        await waitFor(() => expect(danger).toHaveBeenCalledTimes(2));
        expect(show).not.toHaveBeenCalled();
      });

      it('a partner’s not-ready 423 is a notice, not a prompt', async () => {
        handleError(locked({ reason: 'not-ready' }), 'Couldn’t open');
        await waitFor(() =>
          expect(info).toHaveBeenCalledWith(
            'Some of these Locked items aren’t ready yet. They open after their owner next opens Locked.',
          ),
        );
        expect(show).not.toHaveBeenCalled();
      });
    });
  });
});
