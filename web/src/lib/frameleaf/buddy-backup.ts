import type { BuddyStatusDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

/**
 * Presentation only. The server validates grants, licences and identity for every operation. An existing
 * pairing needs no Frameleaf Cloud plan on the same home network. Away from home, Cloud hands a buddy this
 * server's direct, custom or relay address only while its owner has a plan (FL-513). A licence is checked
 * when a new pairing is made, not for every backup (FL-434).
 */
export const buddyBackupPresentation = (status: BuddyStatusDto | null, linked: boolean, now = Date.now()) => {
  const pairing = status?.pairing;
  const active = pairing?.state === 'active';
  const write = !!(active && linked && status?.enabled && status.settings);
  const read = !!(
    linked &&
    status?.keyFingerprint &&
    status.recoveryVerified &&
    (active || (pairing?.state === 'ended' && Date.parse(pairing.readUntil ?? '') > now))
  );
  let outgoing: Translations = 'frameleaf_buddy_not_paired';
  let incoming: Translations = 'frameleaf_buddy_not_configured';
  if (pairing) {
    const restricted: Translations | undefined =
      pairing.state === 'blocked'
        ? 'frameleaf_backup_blocked'
        : pairing.state === 'ended'
          ? 'frameleaf_backup_ended'
          : pairing.state === 'pending'
            ? 'frameleaf_backup_pending'
            : linked
              ? !status?.enabled
                ? 'frameleaf_backup_recovery_only'
                : undefined
              : 'frameleaf_backup_authorization';
    outgoing =
      restricted ??
      (status?.settings
        ? status.settings.pausedSending
          ? 'frameleaf_backup_paused'
          : !status?.recoveryVerified || !status.keyFingerprint
            ? 'frameleaf_backup_key_required'
            : ((
                {
                  capturing: 'frameleaf_backup_capturing',
                  sending: 'frameleaf_backup_sending',
                  paused: 'frameleaf_backup_paused',
                  'waiting-peer': 'frameleaf_backup_waiting_peer',
                  'waiting-quota': 'frameleaf_backup_waiting_quota',
                  'waiting-key': 'frameleaf_backup_key_required',
                  'waiting-authorization': 'frameleaf_backup_authorization',
                  incomplete: 'frameleaf_backup_incomplete',
                  complete: 'frameleaf_backup_complete',
                } as Record<string, Translations>
              )[status.run?.state ?? ''] ?? 'frameleaf_buddy_ready')
        : 'frameleaf_buddy_not_configured');
    incoming =
      restricted ??
      (status?.settings
        ? status.settings.pausedReceiving
          ? 'frameleaf_buddy_receiving_paused'
          : 'frameleaf_buddy_ready_to_receive'
        : 'frameleaf_buddy_not_configured');
  }
  return { outgoing, incoming, write, read, send: write && !!status?.recoveryVerified && !!status.keyFingerprint };
};

const BUDDY_CONNECTIONS = new Set(['local', 'wan', 'ipv6', 'relay']);

/** How the last transfer reached the buddy, in words; null before the first transfer. */
export const buddyConnectionKey = (connection: string | null | undefined): Translations | null =>
  connection
    ? ((BUDDY_CONNECTIONS.has(connection)
        ? `frameleaf_buddy_connection_${connection}`
        : 'frameleaf_buddy_connection_other') as Translations)
    : null;
