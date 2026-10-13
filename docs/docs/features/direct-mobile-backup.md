---
sidebar_position: 20
---

# Direct mobile backup

Mobile backup keeps direct HTTPS over the home network, WAN and IPv6 as its first
choice. When the selected HTTPS route uses the Frameleaf relay, a foreground
native app can negotiate a direct WebRTC upload to the home server. If direct ICE
cannot connect, the existing resumable HTTPS upload remains available subject to
the user's relay policy.

The authenticated API is `POST /api/assets/uploads/{id}/direct`. Its strict JSON
offer and answer are `{ "version": 1, "sdp": "..." }`, each bounded to 65536 UTF-8
bytes. The offer must contain one application-only UDP/DTLS/SCTP data-channel
section. HTTPS authenticates the answer fingerprint. No TURN credentials, relay
ICE candidate, arbitrary URL, HTTP proxy or filesystem operation is accepted.

Both peers gather complete candidates before exchanging descriptions. The default
STUN endpoints are `stun:us1.relays.frameleaf.cloud:3478` and
`stun:ca1.relays.frameleaf.cloud:3478`. They perform binding only; backup bytes
travel over the direct DTLS channel. STUN unavailability can leave host candidates
usable locally; an unsuccessful direct path retains HTTPS fallback.

Use one reliable ordered `frameleaf-upload-v1` data channel. Each text control
frame is at most 1024 bytes:

```json
{"version":1,"type":"append","requestId":"00000000-0000-4000-8000-000000000001","offset":0,"length":65536,"complete":false}
```

Send the declared bytes in binary messages of at most 65536 bytes. Only one append
may be in flight; its length may not exceed the native resource limit or 4 MiB.
An empty append is accepted only with `complete: true`, retaining native final
processing retry semantics. Controls reject unknown fields and unsafe integer
ranges. Overlapping requests, extra channels and mismatched bytes terminate the
direct peer.

ACKs have `version`, `type: "ack"`, the same `requestId`, native `status` of 200,
202 or 204, durable `offset`, and native `complete`. A native completed receipt
adds `result: {id, status, sha256}`. Refusals return only
`{version:1,type:"error",requestId,status}`. Authentication, malformed protocol,
ownership and integrity refusals are not permission to fall back around them.

The server validates current resource ownership before allocating a peer. Each
append reuses live `AuthService.authenticate` with WAN `asset.upload` permission,
including current session/API-key and remote-sign-in restrictions, and then uses
the unchanged native append admission fence, durable parts, checksum verification
and ingestion. Private metadata, SDP, credentials, ICE addresses and payload are
excluded from signaling and transport logs.

Admission allows at most 16 peers across API workers and two per account. Shared
SQL leases expire after five minutes, including a crashed worker. Negotiation is
bounded to ten seconds, idle time to thirty seconds and lifetime to five minutes.
The pinned RTC package also bounds incomplete SCTP reassembly before application
frame validation. Closing a peer releases admission and clears buffered bytes and
credential references.

After a connection loss or missing commit ACK, close the peer and authenticate a
native HEAD of the same resource before resuming its remaining bytes through the
best permitted HTTPS route. Recheck relay permission. Keep the journal and resource;
do not guess an offset or create another asset. Existing create, result and Live
Photo pair commit continue over HTTPS.

iOS foreground direct uploads do not replace Photos system-managed background
uploads. Partial resources stay journaled for foreground resume; a whole-file
Photos job cannot upload a suffix. Android retains existing job cancellation,
lifetime and notification rules. Physical cellular/NAT traversal, handoff, screen
lock and real OS background scheduling remain the separate FL-396 qualification.
