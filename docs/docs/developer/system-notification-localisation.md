# Origin-server notification localisation (FL-329)

The origin server renders explicitly registered system templates before persistence or push encryption.
The existing NotificationDto and frameleaf-push-v1 title/body contract remains unchanged. Web and native
consumers display supplied text; they do not interpret template identifiers or arguments. Cloud has no
translation role and receives only the existing opaque encrypted push envelope. No translation service
is contacted. Names, album names, captions and messages are inserted verbatim, never translated or
interpreted as markup. Existing payload length and preview/privacy guards still apply after rendering.

## Locale authority

The existing authenticated user-preferences API stores `notifications` in user_metadata:

```json
{
  "notifications": {
    "locale": "en",
    "devices": [{ "sessionId": "11111111-1111-4111-8111-111111111111", "locale": "fr-CA" }]
  },
  "expectedRevision": "the current preference revision"
}
```

Use the current revision when changing the device list, which replaces the whole list. There are at
most 100 unique session overrides. The account locale controls newly persisted in-app notifications
for every web session. Push selects the override of its registered device's session, then the account
locale, then English. Revoked or unrelated session identifiers cannot match that user's delivery
targets; stale entries are inert. No request Accept-Language, machine locale, Cloud setting, device
OS locale, or anonymous preference changes this authority implicitly. A native app must explicitly
adopt this existing preference API when its notification-language setting changes.

Push reads current preferences for each delivery and gateway retry; queued notices do not freeze a
locale. A saved notification retains its original rendered text when preferences change, including
legacy English rows. Changing the account locale affects new in-app notices. A device override affects
only pushes to that session. In-app/push text agrees where the same template and locale are selected;
existing channel-specific titles and album invitation wording are preserved.

Only exact canonical BCP-47 locale matches are used: no unapproved dialect substitution. Invalid,
unsupported, absent, or stale catalogs fall back to the producer's supplied English. Unknown internal
template keys/versions, invalid or additional arguments, missing messages, and invalid placeholders
also preserve supplied text. The internal version binds the catalog to its English source revision;
it is not a new wire protocol. Changing that source requires a reviewed new internal version and
matching locale reviews. A typed template/argument wire protocol remains the separately reviewed
future option from FC-111.

## Current source and acceptance map

| Requirement                                                      | Source evidence and remaining gate                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin rendering before encryption                               | `PushService.handleDeliver` resolves current preferences; `buildPushPayload` renders then bounds text; `plan` seals the existing payload.                                                                                                                                                                                   |
| Origin rendering before in-app persistence                       | NotificationService job-failure, item-sharing, cluster-request, shared-space mention/reply and shared-album invite/update producers render before `notificationRepository.create`.                                                                                                                                          |
| Typed arguments and safe fallback                                | `notification-locale.ts` has versioned origin-only descriptors, runtime argument validation and placeholder validation; it never searches supplied English to infer a template.                                                                                                                                             |
| Producer / reusable native contract vectors                      | `server/test/fixtures/system-notification-locale.json` and `notification-locale.spec.ts`: known/new/unknown versions, unknown keys, legacy English, unsupported/stale locales, invalid arguments, verbatim names and existing encrypted v1 fields. Native consumer adoption/tests are excluded from this non-mobile packet. |
| Web parity                                                       | NotificationPanel spec renders every shared vector through NotificationItem, retaining text and escaping user markup. No client translation logic is introduced.                                                                                                                                                            |
| Preference changes and retry/deduplication                       | PushService spec checks two devices with different authority, a preference change before a targeted retry, unchanged collapse identity, and ciphertext-only gateway requests. Existing event recipient selection, access/privacy filtering, retries, invalid-token handling and Live Activities remain in place.            |
| No body logging                                                  | PushDeliver joins the existing sensitive-job guard; JobError redacts its payload, including template arguments. It was already never manually retried, so that policy is unchanged.                                                                                                                                         |
| Critical translations                                            | **Pending FC-109 locale/tone decisions and FC-110 named native-speaker/source-version signoff.** Production catalogs currently contain English only; test pseudo-locales are fixtures and are never shipped as enabled languages.                                                                                           |
| Independent privacy/contract review and hosted exact-head checks | Required on the final integrated PR #140 head; a local fixture pass is not this acceptance.                                                                                                                                                                                                                                 |

The catalog currently registers 13 template forms: job failure; item share singular/plural; cluster
request; space mention/reply; in-app album invitation/update; channel-specific push album
invitation/update/reply; album access removal with/without a known album name.

Other current notices remain explicit legacy English: administrator/Cloud/license/Buddy notices,
the Cloud-ML migration notice, administrator grants, reconciliation/stale-backup notices, memories,
partner/role changes, Studio export completion/failure and Cloud Backup activation. Custom notices,
SMTP templates/subjects, captions and messages retain their existing delivery behavior. Completing
translated coverage for these system producers requires explicit reviewed template registrations
and approved locale catalogs; this bounded producer/contract packet does not claim that coverage.

PR #140 remains draft/open/unmerged with automatic merge disabled. No deployment, translation
publication, native distribution or language qualification follows from this packet.
