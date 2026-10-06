import { State as BuddyPairingState, type BuddyStatusDto } from '@frameleaf/sdk';
import { buddyBackupPresentation } from './buddy-backup';

const paired = (): BuddyStatusDto => ({
  enabled: true,
  configured: true,
  instanceId: 'source',
  settings: {
    directory: '/buddy',
    quotaBytes: 100,
    uploadMbps: 20,
    downloadMbps: 20,
    schedule: '0 2 * * *',
    timezone: 'UTC',
    windowStart: '00:00',
    windowEnd: '00:00',
    pausedSending: false,
    pausedReceiving: false,
    includeDerived: false,
    configurationFiles: [],
  },
  pairing: { version: 1, pairId: 'pair', state: BuddyPairingState.Active, readUntil: null, vaults: [] },
  recoveryVerified: true,
  keyFingerprint: 'verified-key',
  lastCompleteAt: null,
  lastVerifiedAt: null,
  run: null,
  connection: null,
  transferMbps: 0,
  pendingObjects: 0,
  availableBytes: null,
  capacityUpdatedAt: null,
  hosting: { committedBytes: 0, reservedBytes: 0, quotaBytes: 100 },
});

describe('Buddy backup controls and recovery presentation', () => {
  it('keeps recovery after a subscription expires or the write kill switch turns off', () => {
    const status = paired();
    expect(buddyBackupPresentation(status, true, false)).toMatchObject({
      outgoing: 'frameleaf_backup_recovery_only',
      incoming: 'frameleaf_backup_recovery_only',
      write: false,
      send: false,
      read: true,
    });
    status.enabled = false;
    expect(buddyBackupPresentation(status, true, true)).toMatchObject({ write: false, send: false, read: true });
  });

  it('never reopens a blocked pairing after its key is verified', () => {
    const status = paired();
    status.pairing!.state = BuddyPairingState.Blocked;
    expect(buddyBackupPresentation(status, true, true)).toMatchObject({
      outgoing: 'frameleaf_backup_blocked',
      incoming: 'frameleaf_backup_blocked',
      write: false,
      read: false,
    });
  });

  it('allows only reads during the recovery window and closes them at the deadline', () => {
    const status = paired();
    status.pairing!.state = BuddyPairingState.Ended;
    status.pairing!.readUntil = '2026-11-01T00:00:00Z';
    expect(buddyBackupPresentation(status, true, false, Date.parse('2026-10-31T23:59:59Z'))).toMatchObject({
      send: false,
      write: false,
      read: true,
    });
    expect(buddyBackupPresentation(status, true, true, Date.parse(status.pairing!.readUntil))).toMatchObject({
      send: false,
      write: false,
      read: false,
    });
  });

  it('requires Cloud authorization and the source key without hiding incoming storage', () => {
    const status = paired();
    expect(buddyBackupPresentation(status, false, true)).toMatchObject({ send: false, write: false, read: false });
    status.keyFingerprint = null;
    expect(buddyBackupPresentation(status, true, true)).toMatchObject({
      outgoing: 'frameleaf_backup_key_required',
      incoming: 'frameleaf_buddy_ready_to_receive',
      send: false,
      write: true,
      read: false,
    });
  });

  it('keeps sending and receiving pause labels independent', () => {
    const status = paired();
    status.settings!.pausedSending = true;
    expect(buddyBackupPresentation(status, true, true)).toMatchObject({
      outgoing: 'frameleaf_backup_paused',
      incoming: 'frameleaf_buddy_ready_to_receive',
      send: true,
    });
    status.settings!.pausedReceiving = true;
    expect(buddyBackupPresentation(status, true, true).incoming).toBe('frameleaf_buddy_receiving_paused');
  });

  it('keeps replacement recovery available without offering to receive into an unconfigured host', () => {
    const status = paired();
    status.configured = false;
    status.settings = null;
    expect(buddyBackupPresentation(status, true, true)).toMatchObject({
      incoming: 'frameleaf_buddy_not_configured',
      read: true,
      send: false,
      write: false,
    });
  });

  it('offers no transfers or restores before pairing is authorized', () => {
    expect(buddyBackupPresentation(null, true, true)).toMatchObject({ write: false, send: false, read: false });
    const status = paired();
    status.pairing!.state = BuddyPairingState.Pending;
    expect(buddyBackupPresentation(status, true, true)).toMatchObject({ write: false, send: false, read: false });
  });
});
