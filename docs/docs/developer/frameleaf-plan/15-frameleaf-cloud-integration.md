# Frameleaf Cloud integration (self-hosted workstream `cloud`)

Status: reviewed planning contract for workstream `cloud` (Plan IDs `CLD-*`), not implementation, qualification, release or deployment evidence. Read the [implementation plan](00-implementation-plan.md), the [agent execution guide](01-agent-execution.md) and the approved design record (`docs/superpowers/specs/2026-09-24-frameleaf-cloud-design.md`) first. Every item in this workstream is `planned-not-qualified`; nothing is enabled or contacted before an administrator opts in, and the cloud base address is deployment configuration, never a setting.

## 4. Contracts (instance ↔ cloud), condensed

Full DTO tables are in Workstreams A/B; `packages/contracts` (Zod 4 + golden fixtures) is the single source
both repos test against.

- **Discovery** `GET https://api.frameleaf.cloud/.well-known/frameleaf-services` → `{version, validFor:86400, issuer, api, ml:{eu,na}, endpoints{heartbeat,commands,entitlements,licenseRefresh,relayToken,dnsTxt,backupGrant,mlGrant}, jwks{oidc,keys}, regions[], intervals{heartbeatSec:300, entitlementRefreshSec:86400, relayTokenRefreshPct:50}, limits}`; `GET /v1/discovery` (instance auth) adds per-instance service statuses + entitlements.
- **Link** (RFC 8628 from the admin UI): `POST id./device/auth` (client `frameleaf-link`, `instance_name/version/jkt/platform`) → user code `XXXX-XXXX` (BCDFGHJKLMNPQRSTVWXZ), `verification_uri_complete`, 600 s, interval 5; approval page shows server name, version, key fingerprint, IP locale; step-up required; `POST /token` device grant → 10-min link token → `POST api./v1/instances {instanceId, name, version, platform, jwk, bootId, capabilities, permissions}` (the instance's own UUIDv7 `instanceId`) → `{instanceId, oidc:{issuer, clientId=instanceId, scope:"openid email profile", roleClaim:"frameleaf_role", storageLabelClaim:""}, services, owner{accountId, label, email, dataRegion}}`. The cloud registers the instance's OIDC client itself (`private_key_jwt` with the instance key, exact-match https redirect URIs it builds from the relay origin and verified custom hostnames: `/auth/login`, `/user-settings`, `/link`, `/api/oauth/mobile-redirect`, plus `frameleaf-auth:///oauth-callback`, and the back-channel logout URI); the answer carries no initial access token and the instance never runs dynamic client registration or sends redirect URIs (FL-177, as-built decisions #4, #7–#9). Refusals the instance explains to the administrator: 402 `instance-limit`, 403 (server removed or account suspended), 409 `instance-id-taken` (this server, or another one with its ID, is still registered, for example after an offline unlink), 409 `jwk_already_bound`. The registration carries a DPoP proof by the key being linked (see **DPoP**; FL-178). Headless: `FRAMELEAF_LINK_TOKEN=fll_…` (single use, ≤1 h) as `X-Frameleaf-Link-Token`.
- **Tokens**: `client_credentials` + `client_assertion` (EdDSA, `iss=sub=client_id=instanceId`, `aud=https://id.frameleaf.cloud/token`, `jti`, `exp≤5 min`, `kid`) + `resource=` + a DPoP proof (see **DPoP**) → DPoP-bound JWT 10 min, `scope:"instance"`, `cnf.jkt` and `frameleaf_kid`. Key rotation `GET /v1/instance/keys/nonce` + `POST /v1/instance/keys/rotate {newJwk, proof}` (old key retiring 24 h).
- **Key rotation (FC-19)**: the proof is a compact JWS `{alg:"EdDSA", typ:"JWT", kid}` over `{nonce, jkt:<new kid>}`, signed by the active key or by a retiring key inside its window; the token for the nonce and rotate calls must come from a client assertion by that same key. A rotation proven by a retiring key revokes the active key at once, makes the new key active and leaves the retiring key its original deadline (24 h from the rotation that retired it), which is never extended. Nonces are single use for 5 min. At most 3 rotations per instance per hour. Error codes (envelope `code`) on both endpoints: `key_retired` (401, the proof or assertion key is revoked or past its window), `nonce_invalid` (401, unknown, reused or expired nonce), `rate-limited` (429, `Retry-After` in seconds); fixtures `key-retired.json`, `nonce-invalid.json` and `rotation-rate-limited.json` under `packages/contracts` `fixtures/errors/`. Instance behaviour (FL-175): a key file that does not parse is set aside as `<file>.corrupt-<time>-<random>` (0600), never deleted, and the current key is never replaced by an unreadable one. When the key the cloud accepted cannot be read, the instance keeps its previous (now retiring) key and writes a flushed marker `instance-key.rotate-needed.json` `{since, until}` before setting the key aside; a check-in that succeeds warns the administrators and rotates again, signing both the assertion and the proof with the retiring key and keeping its original deadline. A candidate key a lost answer left is asked about first and promoted when the cloud holds it, and no new rotation starts while a candidate is open. `nonce_invalid` gets one immediate retry with a fresh nonce; other failures retry no more often than every 20 min (or after `Retry-After`, never past `until`); `key_retired`, or a marker past `until`, stops, clears the marker and asks an administrator to link the server again (relink needed, with an administrator notice). A 401 without a code counts as `key_retired` only for OAuth `invalid_client`. Each change of state is recorded in the administrator history (`cloud-key-recovery-rotation`: `retrying`, `rotated`, `window-closed`); the recovery runs whatever the cloud command permissions are set to. Linking or unlinking clears the marker. When the check-in's own token request gets `invalid_client` while a recovery is open (and no candidate key turns out to be the one the cloud holds), the previous key's window has closed: the instance records `window-closed`, clears the marker and ends the link as revoked with the reason "This server’s identity key could not be replaced before its previous key expired." When the check-in itself gets `key_retired` (401, envelope code) for a token of the current key while a recovery is open, the recovery closes the same way but the link is not revoked: the instance records `window-closed`, clears the marker and asks for a new link (relink needed, with the key-expired notice). A rotation proved by a retiring key is accepted only while the active key has never been used (no token minted with it, no rotation proved by it), so the instance never mints a token with a candidate or next key except to ask the cloud whether it holds a candidate (below); the recovery is covered because, where the file system can flush, the damaged key is set aside before any token is minted with it (on a mount that cannot flush, a crash could in principle leave a key the cloud already saw a token for). Outside a recovery, `invalid_client` on a check-in's token request first asks about a candidate and otherwise ends the link as revoked. `key_retired` on a check-in follows one path (FL-177, FL-178): a token of a key another worker replaced meanwhile only counts as a failed check-in; otherwise, unless this path already asked for a new link (`relinkReason` `key`) or a recovery already closed, a candidate is asked about and promoted when the cloud holds it, else an open recovery closes, else the administrators are asked once to link the server again; the link is never revoked. A relink the cloud commanded earlier does not skip asking about the candidate. A later check-in that succeeds clears a relink request this path made (the cloud accepts the key again); a commanded relink, or one after a closed recovery, stays until the server is linked again. Only a token response that parsed and was then refused here (not DPoP-bound, or bound to another key) counts as the cloud accepting a candidate; any other success status that is not a token response (a captive portal's HTML, invalid JSON, an oversized body) leaves the candidate's answer unclear. When the token endpoint answers the candidate's assertion with a token response that parses but is refused here (not DPoP-bound, bound to another key, unreadable token), the candidate counts as accepted and is promoted, since the cloud only issues a token for a key it holds; promotion keeps the current key as retiring. A candidate is always resolved (promoted, discarded, or kept while the answer is unclear) before a recovery or a commanded `key.rotate` starts a rotation, and before any rotation nonce is fetched; with no clear answer the recovery retries after 20 min and the command is acknowledged `failed`. A next key found at load never replaces a candidate: the candidate is first moved to `<file>.superseded-<time>-<random>` (0600) and kept for an operator.
- **DPoP (FC-66, RFC 9449; FL-178)**: the cloud accepts bearer instance tokens only while its `instance.bearer_compat` flag is on, which it is not in production, so every instance token is DPoP-bound to the instance identity key. Proof: header `{typ:"dpop+jwt", alg:"EdDSA", jwk:{kty:"OKP", crv:"Ed25519", x}}` (no `kid`), payload `{jti:uuid, htm, htu, iat, nonce?, ath?}`; `htu` is scheme://host[:port]/path with no query or fragment (default ports dropped); `ath` = base64url(SHA-256(access token)), on api and ml calls only. Token request: `POST {issuer}/token` with a `DPoP` header and the `client_assertion`, both signed by one key; the answer must be `token_type` `DPoP` with `cnf.jkt` (and `frameleaf_kid`, when present) equal to that key's thumbprint, else the instance refuses the token. Tokens are cached per key and a token of a key a rotation replaced is dropped. API and ML calls, heartbeat included: `Authorization: DPoP <token>` + `DPoP: <proof>` signed by the key the token is bound to (the current key; during a recovery after a damaged key the previous, for the cloud retiring, key; the candidate key only while asking about it). Registration: `POST {api}/v1/instances` carries a proof by the key being linked (`htm` `POST`, `htu` `{api}/v1/instances`, no `ath`) next to the link token. Contract (confirmed by the cloud): on `POST /v1/instances` the proof, including a `use_dpop_nonce` challenge, is fully validated before the link token (device-flow token or headless `fll_`) is consumed, so a refused proof or a nonce challenge leaves the link token usable and the single retry sends the same link token with the nonce. Nonces: the token endpoint answers `400 {error:"use_dpop_nonce"}`, api and ml `401` with code `use_dpop_nonce` and `WWW-Authenticate: DPoP error="use_dpop_nonce"` (quoted or as a bare token; fixture `use-dpop-nonce.json`), each with a `DPoP-Nonce` header; the instance keeps the latest nonce per origin, replaces it whenever any answer carries a new one, and retries once with a fresh proof carrying the nonce the challenge itself sent (not a nonce a parallel call stored meanwhile), and, for the token request, a fresh client assertion. A `use_dpop_nonce` answer never clears the token cache; any other 401 does. Cloud-side limits: `iat` within ±60 s of the cloud's clock (the instance uses its own clock), a `jti` is never reused within 5 min, a bad proof gets `401 invalid_dpop_proof`, a bearer call to a DPoP audience gets 401. The OIDC client for Sign in with Frameleaf is not an instance token and is unchanged.
- **As built in the app (FL-177)**, from the as-built contract decisions (frameleaf-cloud `docs/app-integration-as-built.md` section 6); the parser tests use the `packages/contracts` golden fixtures copied to `server/test/fixtures/frameleaf-cloud-contracts`:
  - Address rule: every address the cloud hands over (discovery `issuer`, `api`, `ml.*`, `endpoints.*`, `store`, the sign-in issuer and logout endpoint, account-app links) must be the configured host, a subdomain of it, or, only when the configured host is under an allowlisted registrable domain (`FRAMELEAF_CLOUD_REGISTRABLE_DOMAINS`, today just `frameleaf.cloud`), any subdomain of that domain (so `id.` and `account.frameleaf.cloud` under `FRAMELEAF_CLOUD_URL=https://api.frameleaf.cloud`); on the configured port, https unless the configured address is http, with no credentials. Any other configured host (shared hosting domains such as `herokuapp.com` or `github.io`, registry domains, IP addresses, development clouds) accepts only itself and its own subdomains.
  - `bootId`: one per server start, written to system metadata (`frameleaf-boot`) when the microservices worker starts and read by every worker, so registration, "Check in now" and scheduled check-ins send the same value.
  - No client secret: `frameleafCloud.signIn.clientSecret` and the `frameleaf-oidc-client-secret` credential are removed; a secret an earlier version saved is dropped at start-up. Sign in with Frameleaf authenticates with the instance key only; `secret.rotate` drops cached tokens and discovery.
  - Error envelope `{code, message, retryable, refusal, detail, data, requestId}`: `refusal` is a kebab-case `MlAdmissionRefusal` value (`request-invalid` added; 422 falls back to it), `detail` a string or null, `data` an object; a field with another shape is dropped on its own so `code` always survives. Codes acted on: `instance_revoked` (revoke), `invalid_token` (mint a new token, never a revoke), `key_retired` (see **Key rotation**: a candidate key is tried, else an open FL-175 key recovery closes or the administrators are asked to link again, once; never a revoke), `entitlement-missing`, `consent-version-outdated`, `daily-cap`, `instance-id-taken`, `instance-limit`, `jwk_already_bound`, `step-up-required`.
  - AI Wallet: gateway `*Usd` fields are decimal USD rounded to micro-USD. With the instance token the server may only lower the daily cap or turn automatic top-up off; raising the cap and turning automatic top-up on are links to the account app (`settingsUrl` from the wallet, or `data.url` of a 403 `step-up-required`, both address-checked); the server passes the refusal on as a 403 with `code: "step-up-required"`, which is what the web app matches.
  - Usage `GET /v2/usage?since=<ISO 8601>` items `{jobId, clientRef, settledUsd, credits, settledAt, modelSku, computeSku, gpuSeconds, workers, estimateUsd}`; settlements show `modelSku` and `computeSku`.
  - Licence activation from an unlinked server: the body is a compact JWS (`application/jose`) signed by the identity key, whose header carries the public key as `jwk` (`{kty:"OKP", crv:"Ed25519", x}`, RFC 7515 §4.1.3) and its RFC 7638 thumbprint as `kid` (= `fingerprint.jkt`), over `{key, fingerprint, instanceName, aud, iat, exp (≤120 s), jti}`; the cloud verifies against the header key, checks the thumbprint, `aud`, lifetime and single-use `jti`, and binds the certificate with `cnf.jkt` (as-built decision #39 as amended). A linked server sends JSON with its DPoP-bound instance token (FL-178). Either way `fingerprint.jkt` and the key that signs (the JWS header `kid`, or the token's key) come from one key snapshot. The activation JWS is not a DPoP proof. When the instance ID is already registered with another key (409 `instance-id-taken`), the administrator is told the identity key does not match and to link the server again.
  - Unlink or revoke removes the plan certificate; supporter key certificates stay.
  - Sign in with Frameleaf: `frameleaf_role` is applied on every sign-in to every linked account, except that it never demotes the server's only administrator (owner rule: the server stays manageable; the refusal is logged; the count and the demotion run under one database lock so two sign-ins at once cannot demote the last two); Account & link says a role change applies at the person's next Sign in with Frameleaf; `frameleaf_access` grants nothing. Signing out of a Frameleaf session goes through the issuer's `end_session_endpoint` with `client_id` and `id_token_hint`.
  - Store: the Support and buy links use discovery's `store` (as the link last recorded it, or as the process holds discovery) with `?product=<id>`, else `{FRAMELEAF_CLOUD_URL}/store`.
- **Heartbeat** `POST /v1/instance/heartbeat` every 5 min `{version, bootId, uptimeSec, health, endpoints[≤16], remoteAccess, permissions, licenseKid}` → `{commands[], entitlementsChanged, servicesChanged, nextHeartbeatSec, cloneSuspected, notices[]}`; commands `remote.enable|remote.disable|backup.run|secret.rotate|key.rotate|relink`, honoured only if the instance-side permission flag allows; `POST /v1/instance/commands/:id/ack`. Clone rule: ≥3 alternations between two `bootId`s in 30 min → `clone_suspected` (owner email, backup grant refused).
- **Clone suspicion and ML tokens (FL-185; instance contract v12, frameleaf-cloud #27)**: while an instance is `clone_suspected`, the token endpoint answers an ML-audience token request (`resource` = the regional gateway) 400 `{error:"clone_suspected"}` (fixture `exchanges/token-clone-suspected.json`). It is not transient: it lasts until the owner acknowledges it in the account app (`POST {id}/v1/instances/:id/clone-ack`, step-up) or 24 hours pass without a `bootId` change. The server treats it like `cloneSuspected: true` on a check-in: it records a persisted ML suspension (`SystemMetadataKey.FrameleafMlSuspension {reason:"clone-suspected", cloudUrl, instanceId, since}`, ignored for any other link and cleared by unlink, revoke and a new link; a failed write never stops those or the refusal), sends the administrators the shared notice (`frameleaf-cloud:clone-suspected`, "Two servers are using this server’s identity"; every new suspicion notifies and the dedupe key keeps it to one a day) and shows the clone banner (`cloneSuspected` in `GET admin/cloud/status`). While suspended, `resolveCloudGateway` requests no ML token (no retry, no backoff) and refuses with `cloud-unavailable` and a detail saying cloud processing is paused because the server's identity is in use in two places. A check-in that first reports `cloneSuspected: true` records the same suspension. It clears when a check-in reports `cloneSuspected: false`. While it is recorded and check-ins still report `cloneSuspected: true`, every check-in (the first report included, with or without `servicesChanged`) asks `GET {api}/v1/discovery` (instance token) and clears it once `services.ml.status` is no longer `suspended` or the document's `cloneSuspected` is `false`; a failed answer keeps it until the next check-in and never fails the check-in. As a safety valve, 24 hours after `since` one ML token request is allowed (claimed under `DatabaseLock.FrameleafMlProbe` = 949, which re-reads the suspension and rewrites `since` before the lock is released, so concurrent admissions on any worker are refused rather than probing too; a `since` that does not parse counts as expired): a token clears the suspension, a new `clone_suspected` refusal records it again from then (without another notice), so a suspension a missed answer left, or one an in-flight token request re-recorded after a clear, never blocks cloud processing for good. API-audience tokens, the heartbeat, commands, entitlements, licence refresh and relay are unaffected; backup grants follow the heartbeat clone rule on the cloud side.
- **Claims to instances** (id token + userinfo): `sub` (account UUIDv7), `email`, `email_verified`, `name`, `picture?`, `frameleaf_role` (`admin` for owner/admin else `user`), `frameleaf_access`, `sid`, `auth_time`. Prompt `instance-access` runs on **every** authorization: `email_verified`, `instance_access(account, client_id)` (owner implicit), account/instance status; consent stored once, access check never skipped. Back-channel logout on unshare/unlink/suspend.
- **License certificate** (JWS EdDSA, `typ:"license+jwt"`, `kid`): `{iss, aud:"frameleaf-server", sub:<account>, iid:<instance>, cnf:{jkt}?, lic:{id,last4,kind}?, ent:["CLOUD","REMOTE_ACCESS","CLOUD_BACKUP","CLOUD_ML","SUPPORTER_SERVER"|"SUPPORTER_INDIVIDUAL"], lim:{relay_mbps:8, relay_gb_month:200, backup_bytes:1e12, instances:3}, lic_exp (period end + 3 d; null lifetime), upd:{after:86400,url}, grace_days:7|14, iat, nbf, exp:+7d, jti}`. Endpoints: `POST /v1/licenses/activate {key, fingerprint:{instanceId, jkt?}, instanceName}` (instance or public rate-limited, air-gapped browser page returns the file), `POST /v1/licenses/refresh`, `POST /v1/licenses/deactivate`, `GET /v1/entitlements`, JWKS `GET /.well-known/frameleaf-keys.json`. Refresh (FL-185, instance contract v12): the request's `certificates` is an unordered, informational list of the `jti`s the server holds (nulls are ignored); the answer is always the complete current set, the plan certificate first, then one per usable key activation on the server, and the server replaces everything it holds with it. An account without a plan gets an empty plan certificate, so an answer without one (or an empty list) is malformed: the server keeps everything it holds, records the error on it and retries in an hour (the held set ages out through grace only if this persists). In a well-formed answer a held key certificate it leaves out (a key activation no longer listed) is dropped, not kept to age out through grace; of several key certificates the one for the key already held keeps its `activationId` and hint, else the first is kept; a personal (`individual`) certificate is never held as the server's. Key format `FL-KXXX-XXXX-XXXX` (`K`=S|I, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, Luhn mod 32 check symbol over the kind value (`S`=16, `I`=8) and the ten body symbols, as-built decision #40; cloud stores sha256 + last4; shown once). Server (`server/src/utils/frameleaf-license.ts`) and web (`web/src/lib/frameleaf/cloud.ts`) port `licenseKeyCheckSymbol` from frameleaf-cloud's `packages/contracts/src/licence/key-format.ts` (FL-182), driven by the same golden fixtures the cloud tests against.
- **Relay**: `POST /v1/remote/enroll` → `{label, domain, names{relay, lanPattern, ipv6Pattern}, relay{id,host,port:443}, caa{issue, validationMethods:"dns-01", accountUri}, certProfile:"tlsserver", renewBeforeDays:25}`; `PUT/DELETE /v1/remote/dns/txt {name:"_acme-challenge.<label>", value}` (waits ≤25 s for both NS); `PUT /v1/remote/caa`; `GET /v1/remote/relays/candidates` + `POST /v1/remote/relays/select {measurements}`; `POST /v1/remote/relay-token` → `{token (JWS relay+jwt: sub=instance, sni, relay, cnf.jwk, thr{bps,burst}, lim{conns}, exp +4 h), relay{host, sni:"tun.<relay>", alpn:"fl-tunnel/1"}, refreshAfterSec:7200, throttling, limits, keepaliveSec:30}`; `POST /v1/remote/certs` (CT baseline); `GET /v1/remote/usage`. Relay internal: `/internal/relay/{jwks,denylist,throttles,metering,heartbeat,events}`.
- **Backup grant** `POST /v1/backup/grant` → `{provider:"wasabi", region, endpoint, bucket:"fl-<region>-<instanceId>" (dedicated, created for this instance), credentials{accessKeyId, secretAccessKey (once)} scoped to that bucket only, expiresAt:+90 d, rotateAfterSec, quotaBytes, readOnly, versioning:true, sseC:{required:true, algorithm:"AES256"}, policy{denies:["s3:DeleteObjectVersion","s3:PutBucketVersioning","s3:DeleteBucket"]}}`; `/grant/rotate`, `/usage` (per-bucket utilization), `/runs`, `PUT/GET /escrow {version, kdf, cipher, nonce, ciphertext}` (server-key mode only, optional), `/purge` (30-d hold, deletes the bucket). The cloud never receives the bucket key; it can list object names and sizes only.
- **Cloud ML v2** (regional host from discovery, DPoP-bound instance token `aud` = the region's origin; FC-34 as-built, frameleaf-cloud `packages/contracts/src/ml/*.ts`): `GET /ping` (public) → `{ok:true}`, `GET /capabilities` → `{protocol:"frameleaf-cloud-v2", region, workloads[] (only what can run now: a published model, entitled or in grace, consented at the required version, free balance and not frozen), consent{requiredVersion, recordedVersion, features{identityNames,medicalSignals,ocrAddon}}, entitlement{active, state:"none|active|grace|expired", graceUntil} (the server reads `active`, grace included), wallet{balanceUsd, heldUsd, dailyCapUsd, spentTodayUsd}, limits{maxInputBytes, maxInputs, concurrentTimePriced}, catalogEtag}`, `GET /hardware` (synthetic `{providers:["CUDAExecutionProvider"], cudaDeviceCount:1, preferredAcceleration:"cuda"}` so `readinessOf()` = model-ready), `GET /v2/catalog` → `{etag, models[{sku, workload, rank, label, display{model,gpu}, computeSku, rate{perSecondUsd,startFeeUsd}, eta{p50Sec,p90Sec}, limits, rev, notice?, mode?, licence?{name, commercialHosted:"yes|conditions"}, default?}]}` (`default: true` on at most one published model per workload and region, per workload, mode and region for restoration; none in a group whose recommended model is not available to the region or licence), `POST /v2/estimates` (`{workload, modelSku, inputs[{inputId, contentType, bytes, sha256}], request}`, `request` a strict per-workload allow-list) → `{estimate (sealed `est1.` token), expiresAt:+15 min, modelSku, modelRev, computeSku, cost{p50,p90,startup,hold,minimum}, seconds{coldStart,run}, basis:"measured|modelled"}`, `POST /v2/jobs` (`Idempotency-Key`; `{estimate, workload, modelSku, modelRev, clientRef?, packKey?, deadlineSeconds?, inputs, request}`, which must match what the estimate binds) → 201 `{jobId, status:"admitted", modelSku, modelRev, computeSku, hold{amountUsd,ceilingUsd,minimumUsd}, createdAt}` (uploads and `awaiting_upload` onwards are FC-39), `POST /v2/jobs/{id}/start`, `GET /v2/jobs/{id}` (ETag/Retry-After; `progress`, `run{startedAt, meteredSeconds, workers, startFees}`, `charges{meteredUsd,holdUsd,ceilingUsd}`, `result{outputs[{url,sha256,bytes}], modelSku, modelRev, timing}`, `purgeAfter`), `POST /v2/jobs/{id}/cancel`, `DELETE /v2/jobs/{id}` (ack → purge), `GET /v2/wallet` (+ `settingsUrl`), `GET /v2/usage?since=` → `{items[{jobId, clientRef, settledUsd, credits, settledAt, modelSku, computeSku, gpuSeconds, workers, estimateUsd}]}`, `GET /v2/consent/current` → `{requiredVersion, recordedVersion, recordedAt, features, summary, text, textSha256, documentUrl}`, `POST /v2/consent` `{version, features{identityNames, medicalSignals, ocrAddon:false}, acknowledgedBy?}` → `{recordedVersion, recordedAt, features}`, `DELETE /v2/consent`. Error envelope `{code, message, retryable, refusal, detail, data, requestId}`; mapping: 401 invalid-key→DestinationUnhealthy, 403 consent-missing/consent-version-outdated→ConsentMissing/ConsentVersionOutdated (`data.requiredVersion` names the current version), 403 region-mismatch→DestinationUnhealthy, 403 clone_suspected→CloudUnavailable with the FL-185 ML suspension and notice, 402 insufficient-credits/daily-cap→WalletInsufficient/BudgetExceeded, 409 model-mismatch/model-retired/estimate-expired/estimate-mismatch (a spent estimate answers `estimate-mismatch` with `detail:"used"`)→ModelMismatch, 422 request-invalid→RequestInvalid, 429→QuotaExceeded, 503 `capacity`→DestinationUnhealthy (never a fallback; until FC-39 binds the broker every `POST /v2/jobs` answers it).
- **Gateway wire shape in the server** (FL-183): `server/src/utils/frameleaf-cloud.ts` parses every endpoint above with the FC-34 contract shapes and is driven by the cloud's own `fixtures/ml/**` (see `server/test/fixtures/frameleaf-cloud-contracts/SOURCE.md`). Catalogue entries, estimates, job admission, `job.run` and usage items are strict as the contract is: an internal identifier (`modelId`, `gpuClass`, `modelFingerprint`), a name where a SKU or revision belongs, a restoration model without a `mode` (or a `mode` on any other workload), or a licence with `commercialHosted: "no"` is refused. A refused catalogue entry is left out (counted and logged), never offered. Usage items are checked one at a time the same way (FL-183 review P2-1): a refused item is left out, counted and logged, and every other settlement is still applied, so one bad item never stops the budget from counting for the 30-day window. A refused job status is the cloud being unavailable. Every body the server sends (estimate, job, consent) is checked against the contract first and refused as `RequestInvalid` without a call, so the reserved `ocrAddon` is never sent on and a model name never goes out as a SKU. The sealed estimate is opaque and single use: a job carries it once with the estimate's own `modelSku`/`modelRev` under one `Idempotency-Key` per logical submission (a retry reuses the key and answers the same admission), `estimateUsable` stops one past `expiresAt`, and an admission naming another model or revision than the one sent is refused as `ModelMismatch`. `FrameleafCloudMlRepository` covers `createEstimate`, `createJob`, `getJob`, `cancelJob` and `deleteJob`; the batches that send work (CLD-202, CLD-203) decide when they run. When the gateway itself answers 403 `clone_suspected` (FC-34 `MlInstanceGuard`, as opposed to the token endpoint's OAuth refusal), every gateway call does what FL-185's token path does: `suspendCloudMl` records the ML suspension for the link (so no ML token is asked for until a check-in clears it, or the daily probe), administrators get the one deduplicated `CLONE_SUSPECTED_NOTICE`, and the call is refused as `CloudUnavailable` with `ML_CLONE_SUSPENDED_DETAIL` (review P2-3). `region-mismatch` and `capacity` keep their `DestinationUnhealthy` mapping.
- **Default model** (FL-183, FC-34 cloud decision 2026-09-26): a catalogue entry may carry `default: true`, at most one per group: the cloud workload, and for restoration the workload and mode (`descriptions`, `restoration-faithful`, `restoration-creative`, …; the region is the gateway's own). The probe keeps each group's default among the offered models in `CloudProbeFacts.defaultModels`. Work with no chosen model (FL-186: no `ml_cloud_model_choice` row for its group) uses its group's default; when the group marks none (the recommended model is not available to this region or licence), admission refuses with `ModelMismatch` and asks the administrator to choose a model in Where each job runs, and no other model is ever put in its place. A catalogue that marks two defaults in one group keeps the group's models, names no default for it, and counts the group once in `refused` (logged). Studio AI spans `transcription` and `tts`, so it takes no default and always names its model; unrouted Studio AI work is refused with its own detail, "choose a Frameleaf Cloud model for Studio AI in Where each job runs" (FL-186). `CLOUD_DESCRIPTION_DEFAULT_MODEL` and `cloudModelFor`'s name fallback are gone: a cloud job names only a routed SKU or the catalogue's default. The cloud's fixtures for this were copied from frameleaf-cloud `main` at `5e51087d92` (the FL-183/FL-185 fixture re-sync, before FL-186), and the specs use `ml/catalog-descriptions.json`, `ml/catalog-restoration.json` and `ml/rejected/catalog-two-defaults.json`.
- **Model identity** (FL-183): the cloud's model identity is the model SKU (`ms_` + 8 Crockford base32) with its current revision (`mr_` + 12); both are opaque and never derived from a model name. The server keeps its catalogue-model concept and maps it: `CloudProbeFacts.modelIds`/`modelWorkloads`, the model choice (`ml_cloud_model_choice.modelId`, FL-186; before it `ml_workload_route.modelId`) and the admin catalogue's `CloudMlModelDto.id` hold the SKU (what used to be the catalogue `id`), and `CloudMlModelDto.fingerprint` shows `rev` (what used to be `fingerprint`). `name` is the catalogue `label`, `description` the display-only `display.model`/`display.gpu` (plus a licence `notice`), and `pricingUnit`/`priceUsd` are `second`/`rate.perSecondUsd`. The column's meaning is unchanged (the catalogue's identifier for the chosen model, checked against the last catalogue at admission), so nothing is migrated: a route saved with a name-style id before FC-34 no longer matches the catalogue and is refused as `ModelMismatch` until an administrator picks the model again. A migration that nulls `ml_workload_route.modelId` values not matching `^ms_` was considered and skipped (review suggestion): such routes already fail closed as `ModelMismatch`, and nulling them would silently switch that work to the catalogue's default. A local-only model (FL-146) is recognised by its display name, since a SKU never names it; letters and digits alone are compared, so spaces and punctuation ("Qwen2.5 VL 3B") never hide one. The admin catalogue's `description` also names the start fee (`rate.startFeeUsd`, per worker). FL-186 adds `CloudMlModelDto.group` (the model group it is chosen for), `rank` (the catalogue's ladder position, 1 = lightest) and `isDefault` (the catalogue's `default` mark; always false on a Studio AI model, which never takes a default).
- **Model choice per model group** (FL-186): the one source of truth for the model a cloud job names is the SKU an administrator chose for the job's model group, else the catalogue's default for that group. The groups are the catalogue's own (`catalogGroupKey`, now hyphenated): `descriptions`, `upscale`, `restoration-faithful`, `restoration-creative`, `interpolation`, `transcription` and `tts`, so Studio AI has two choices, speech to text and captions (`transcription`) and speech (`tts`), picked by the Studio feature (`studioAiCloudWorkloadId`; `MlSelectionRequest.studioFeature`). The choice lives in its own table, `ml_cloud_model_choice (modelGroup PK, modelId, updatedAt)` (Frameleaf public migration `2100000000650-AddMlCloudModelChoice`, registered in `ORDER`, the migration manifest and `fork-v2-catalog.json`), not on the route: `selectMlDestination` reads the group's choice whenever a job goes to the Frameleaf Cloud destination, whatever the workload's route points at, so a Both workload routed to this server still sends its chosen model when a person sends a job to the cloud, and moving a route never changes the choice. The migration copies a model already chosen on a route to the Frameleaf Cloud destination when that destination's last catalogue check still lists it for the workload; Studio AI rows are not copied, because a Studio AI model cannot be told apart as a transcription or a speech model. `ml_workload_route.modelId` stays in the schema and is no longer read or written; the route API (`MlWorkloadRouteDto`, `MlWorkloadRouteUpdateDto`) no longer carries `modelId`. API: `GET admin/cloud/ml/models` lists every group's choice (null for the catalogue default), and `PUT admin/cloud/ml/models/{group}` `{modelId}` chooses a SKU, checked against the live catalogue for exactly that group (a faithful model is refused for creative restoration, a speech model for transcription), or null to use the default; `CloudMlModelGroup` is the enum, and `CloudMlModelDto` gains `group`, `rank` and `isDefault` (never true for Studio AI). Admission checks every chosen or default model against its catalogue group (`CloudProbeFacts.modelGroups`, SKU to group, recorded at each check), not only restoration, so a TTS SKU is never sent for speech to text; facts from before FL-186 place no model and admit none until the next check. The read-only views that judge the stored check (the enrichment workbench and plan creation, the restoration destination list, the worker inventory and the capability flags) use the same rule through `storedAdmission`, with the chosen models (`readCloudModelChoices`), so they agree with a job's admission: once a model is chosen where the catalogue marks no default, those views admit Frameleaf Cloud. There, Studio AI counts as available only when both its speech to text and speech models resolve, and the refusal names the one still missing; a stored check from before FL-186 (no `modelGroups`) cannot tell whether the work has a model, so those views show it as waiting for the next check (a transient `DestinationUnhealthy` refusal, "checked before model groups; waiting for the next check"): it is not available in the inventory or the capability flags, and plan creation still accepts it because the live admission checks again, and stored `restoration:faithful`/`restoration:creative` keys are read as the hyphenated ones (`normalizeCloudProbeFacts`). `POST ml-destinations/{id}/admit` takes an optional `studioFeature` (`MlStudioFeature`: `speech-to-text`, `captions`, `speech`); a Studio AI admission without it is refused with "a Studio AI job must name its Studio feature", and one whose feature has no model with "choose a Frameleaf Cloud model for Studio AI speech to text and captions" (or speech). The web's static-name slider setting (`frameleafCloud.cloudMl.models`) is retired: it was read only by the web slider and a local-only check in the configuration schema, and never by admission. The key is gone from `AdminConfigFrameleafCloudMlDto` (OpenAPI and SDK), and a value an earlier version stored is dropped when the configuration is read. In Where each job runs, every kind of work set to Both or Cloud only, with Frameleaf Cloud on, shows a Frameleaf Cloud model picker per group, whatever its route: the catalogue models of exactly that group, lightest first, on the slider's blue band, each with its label, description and price per minute of GPU time, the recommended one marked. With no model chosen the recommended model is selected and marked "Used until you choose another model"; where the catalogue recommends none, and always for Studio AI, the picker says jobs are refused until a model is chosen. The picker stays enabled while it saves (focus never drops), shows a choice at once and saves only the latest after a 300 ms pause, one save at a time; a failed save reverts only its own choice, and a newer choice made meanwhile is kept and saved next. "Use the recommended model" saves null and moves focus to the recommended model's radio. The catalogue is read once cloud processing is linked and turned on, including when it is turned on on the page; only the latest read is shown. The Cloud processing page's Models card shows the same pickers. **Owner acceptance pending**: the Sep 22 prototype's slider also has local (white and green) stops; this server's own ML models are chosen in the machine-learning settings and nothing reads a local slider position, so the production picker shows the blue band only, with no inert local stops. The static web catalogue (`gpu-model-catalog.ts`) still drives the job estimate on the Cloud processing page and the `ModelSlider` component kept for the editor, Studio and per-job confirmation ports.
- **Workload IDs on the wire** (FC-66, FL-181; canonical set, never reused): `descriptions`, `upscale`, `restoration`,
  `transcription`, `tts`, `interpolation` are the only IDs `workloads[]`, catalogue `models[].workload`,
  `POST /v2/estimates`/`POST /v2/jobs` `workload` and usage rows ever carry; an ID this server does not know is
  ignored, never guessed at. These are not `MlWorkload` strings: `server/src/utils/frameleaf-cloud.ts` is the one
  boundary mapping between them (`appWorkloadsForCloudId`, `cloudWorkloadIdFor`, `studioAiCloudWorkloadId`,
  `workloadForCatalogEntry`), used everywhere a workload crosses the cloud boundary. Mapping: `enrichment`↔`descriptions`;
  `upscale`↔`upscale`; `restoration-faithful`/`restoration-creative`↔`restoration` (one wire workload; which mode a
  job runs is chosen by the model, and each catalogue entry names its own mode — `models[].mode`, cloud-confirmed
  2026-09-25 as exactly `"faithful"`/`"creative"` on every restoration model, never absent). A restoration mode is
  only ever admitted once the catalogue names a usable model for it (capabilities' `restoration` alone cannot tell
  the modes apart, and a catalogue that could not be read admits neither mode); a chosen model's own mode must also
  match the workload asked for. `interpolation`↔`interpolation` (including interpolation at export); `studio-ai`↔`transcription`
  (speech-to-text and captions) or `tts` (speech) depending on the Studio feature run — a destination is admitted for
  Studio AI if either ID is present, but a specific job needs its own ID. Music is not a cloud workload in v1: a
  Studio AI music job is refused for the cloud by the existing refusal, never silently moved to `transcription` or
  `tts`. Face, clip, OCR, pet recognition and Studio render are never sent to the cloud at all.
- **Wallet flow** (metered GPU time, 2026-09-25): `startup` = start fee × planned workers (chunked video uses up to 5); hold = ceil(p90Run × 1.25) + startup, sized from the p90 estimate including start fees; metering starts at model-ready, seconds round up; at ≥90 % of hold extend by 25 % from free balance; ceiling = hold + 10 % grace (absorbed by us); over ceiling → cancel at next safe point (`cancelled_budget`, completed outputs delivered); complete → charge = max(min, Σ start fees + metered seconds × class rate) ≤ ceiling (min = one start fee), refund rest; our/provider failure → full refund incl. startup; user cancel/their failure → charge to that point (min charge). Ledger append-only (`top_up|hold|capture|release|refund|adjustment|bonus|expiry|chargeback`), `posted ≥ 0`, `held = Σ open holds`; hard kill at model max runtime. Top-ups $20 minimum, $25 default, presets $25 / $50 / $100, no pack bonuses; per-photo and per-minute figures are display estimates (p50–p90), never the billing basis.
- **Via header contract** (edge → API over loopback): `X-Forwarded-For/Proto/Host`, `X-Frameleaf-Via: lan|wan|relay`, `X-Frameleaf-Via-Auth: ${FRAMELEAF_EDGE_SECRET}` (per-boot secret generated by the supervisor); API strips client-supplied `X-Frameleaf-*`.
- **Unlink propagation**: instance revoked → OIDC client deleted + back-channel logout (immediate), token endpoint `invalid_client`, relay denylist (≤2 min), Wasabi keys deleted (≤1 min; data read-only 30 d then purge ≤90 d), ML tokens refused, DNS removed after 24 h grace, audit + owner email.

## 5. Workstream A — self-hosted (this fork)

Root for paths: the fork checkout (currently `/Users/adamtaylor/Github/fl-integration`; work happens in a
fresh worktree from the refetched `master/frameleaf-implementation`).

### A1. Fixed engineering choices

Second OIDC **provider slot** for Frameleaf (runtime-derived `OAuthConfig` fed to the existing
`OAuthRepository.authorize/getProfileAndOAuthSid`; routes `/oauth/frameleaf/*`; `private_key_jwt` with the
instance key, no client secret since FL-177) — never presets `oauth.*` (config-file installs, existing IdPs).
Edge = new `ImmichWorker.Edge`, forked like `Api` in `server/src/main.ts:98-116`, slim `EdgeModule` modelled
on `MaintenanceModule`, single active edge via `tryLock(DatabaseLock.FrameleafEdge)`. Rate limiting =
small ioredis `INCR/EXPIRE` guard (`@RateLimited`). Audit = `recordAdminEvents()` with new
`AdminAuditAction`s. Deps to add: `acme-client`, `@achingbrain/nat-port-mapper`, `@aws-sdk/client-s3` (+ `@aws-sdk/lib-storage` for
multipart) — SSE-C requires the S3 API directly; no restic, no extra binaries in the image.

### A2. Server module map (new)

`repositories/instance-identity.repository.ts` (load/create under `DatabaseLock.FrameleafIdentity`, PEM
`O_EXCL` 0600, `publicJwk`, `kid`, `signAssertion`), `repositories/frameleaf-cloud.repository.ts`
(`discovery()` cached by `validFor`, `request<T>()` modelled on the previous GPU-provider integration's repository `request()` — the one piece of
that code we keep as a pattern, `accessToken(resource)` cache), `services/frameleaf-cloud.service.ts` (link
lifecycle, heartbeat cron + jitter under `DatabaseLock.FrameleafHeartbeat`, commands, unlink, permissions,
audit, `notifyAdmins`), `controllers/cloud-admin.controller.ts` (`admin/cloud`), `dtos/frameleaf-cloud.dto.ts`,
`utils/frameleaf-license.ts` (pure verify/status/flags), `services/frameleaf-license.service.ts` +
`controllers/license-admin.controller.ts` (`admin/license`) + `dtos/frameleaf-license.dto.ts`,
`repositories/frameleaf-account.repository.ts` (fork tables), `services/frameleaf-auth.service.ts` +
`controllers/frameleaf-auth.controller.ts` (`oauth/frameleaf`), `middleware/frameleaf-via.middleware.ts`,
`middleware/rate-limit.guard.ts`, `workers/edge.ts`, `edge/{edge.module,edge-certificate.repository,
edge-proxy.service,edge-direct.service,edge-relay.service,edge-state.service}.ts`,
`repositories/frameleaf-cloud-ml.repository.ts` (job client), `services/cloud-ml.service.ts`,
`services/cloud-ml-batch.service.ts`, `controllers/cloud-ml-admin.controller.ts` + `cloud-ml.controller.ts`,
`dtos/cloud-ml.dto.ts`, `repositories/cloud-backup-store.repository.ts` (S3 client: SSE-C headers on every call, multipart PUT, HEAD/LIST,
GET with sha256 verify), `repositories/cloud-backup-index.repository.ts` (fork table `cloud_backup_object`),
`services/cloud-backup.service.ts`, `controllers/cloud-backup-admin.controller.ts`, `dtos/cloud-backup.dto.ts`,
`commands/cloud-backup.command.ts`; fork migrations `0000000000170-FrameleafAccountLinks`,
`…180-FrameleafSessions`, `…190-FrameleafUserLicenses`, `…200-FrameleafConsents`, `…210-CloudBackupObjects` (`cloud_backup_object`: `sha256 PK`, `bucket`, `size`,
`uploadedAt`, `etag`, `lastSeenAt`; `cloud_backup_manifest`: `id`, `bucket`, `key`, `createdAt`, `assetCount`,
`bytes`, `status`); public migrations
`2100000000620-FrameleafCloudMlDestination` (widen `ml_destination_kind_check` to `local|lan|frameleaf-cloud`
after deleting the previous GPU-provider integration's rows (the two cloud kinds in `CLOUD_ML_DESTINATION_KINDS`) — same shape as `2100000000490-SeparateRestorationWorkers.ts:18-35`) and
`2100000000630-HashSharedLinkPasswords`; medium specs per fork table (`recipient-group.repository.spec.ts` pattern).

### A3. Server changes (existing files)

- `enum.ts`: `SystemMetadataKey.{FrameleafInstance,FrameleafCloudLink,FrameleafServiceDiscovery,FrameleafLicense,FrameleafRemoteAccess,FrameleafCloudBackup,FrameleafMlWallet}` (remove the previous GPU-provider integration's two metadata keys); `ImmichWorker.Edge`; `DatabaseLock.Frameleaf{Identity,Heartbeat,LicenseRefresh,CloudBackup,CloudBackupCheck,CloudMlBatch,Edge}` (unique numbers ≥ 940); `JobName.{FrameleafHeartbeat,FrameleafLicenseRefresh,CloudMlDescriptionBatch,CloudBackupSchedule,CloudBackupVerify}` on `QueueName.BackgroundTask` (+ `JobItem` union, `getJobOptions`); `Permission.{AdminCloudRead,AdminCloudUpdate,AdminCloudLink,AdminRemoteAccessUpdate,AdminCloudBackupRead|Update|Run,AdminCloudMlRead|Update,CloudMlJobCreate|Read,FrameleafAccountRead|Update}` (keep `ServerLicense*`/`UserLicense*`); `AdminAuditAction` set (CloudLinked… FrameleafAccountUnlinked); `ConfigCredential.{CloudBackupBucketKey,CloudBackupS3SecretKey}` (no Frameleaf sign-in client secret, FL-177) (+ `CREDENTIAL_PATHS`, `stripCredentialFlags`, `mapAdminConfig`); `MlDestinationKind.FrameleafCloud='frameleaf-cloud'` in `CLOUD_ML_DESTINATION_KINDS` **replacing** the two cloud kinds in `CLOUD_ML_DESTINATION_KINDS` (the previous GPU-provider integration); `MlWorkload.{Upscale,Interpolation}` (no Studio render workload: Studio exports render locally only, on this server or a LAN worker); `MlAdmissionRefusal.{WalletInsufficient,ConsentVersionOutdated,CloudUnavailable,QuotaExceeded,ModelMismatch,EntitlementMissing}`; `MediaOperationKind.{CloudMlJob,CloudBackup,CloudRestore}`; `MediaOperationDestination.FrameleafCloud`; `ApiTag.Frameleaf{Cloud,License,RemoteAccess,CloudMl,CloudBackup}` + `endpointTags` (`constants.ts`); `ImmichHeader.{FrameleafVia,FrameleafViaAuth}`; `StorageFolder.Frameleaf`.
- `types.ts`: `SystemMetadata` entries — `FrameleafInstance {instanceId, kid, publicJwk, keyFile, createdAt}`, `FrameleafCloudLink {status, cloudUrl, accountId?, accountLabel?, linkedAt?, lastContactAt?, pending?{deviceCode,userCode,verificationUri(Complete),expiresAt,intervalSeconds}, permissions{allowRemoteEnable,allowBackupTrigger,allowEntitlementRefresh}, revoked?, lastError?}`, `FrameleafServiceDiscovery {fetchedAt, validUntil, document}`, `FrameleafLicense {certificate, kind, keyHint?, activationId?, claims, verifiedAt, refreshedAt?, nextRefreshAt?, lastRefreshError?}`, `FrameleafRemoteAccess {status, bootId, names?, certificate?, relay{connected,…}, direct{listening,port,mapping?,cgnatSuspected}, candidates[]}`, `FrameleafCloudBackup {target, bucket?, claimedAt?, keyMode:'server'|'own-stored'|'own-memory', keyFingerprint?, keyLoaded (own-memory: true only while held in process memory), lastRun?, lastSuccessAt?, lastManifestKey?, lastCheckAt?, usage?, escrow?}`, `FrameleafMlWallet {balanceUsd, heldUsd, updatedAt, topUpUrl|null}`.
- `dtos/env.dto.ts` + `config.repository.ts`: `FRAMELEAF_CLOUD_URL`, `FRAMELEAF_IDENTITY_DIR`, `FRAMELEAF_LINK_TOKEN`, `FRAMELEAF_EDGE_PORT` (2443), `FRAMELEAF_EDGE_BIND`, `FRAMELEAF_TRUSTED_LAN_CIDRS`; remove `licensePublicKey`/`productionKeys`/`stagingKeys`; default workers `[api, microservices, edge]`. `main.ts`: fork `Edge`; supervisor sets `FRAMELEAF_EDGE_SECRET`. `app.common.ts`: register via-middleware after `cookieParser()`.
- `dtos/config.dto.ts`: new section `frameleafCloud {remoteAccess{enabled:false, mode:'relay'|'relay-and-direct', directPort:2443, manualPublicPort, portMapping:true, allowOriginalsOverRelay:false, allowPasswordOverRelay:false, publicUrl:'frameleaf'|'custom', customHostname{host, status:'pending'|'verified', checkedAt}}, signIn{buttonText (Public), showOnLocalLogin} (no client secret, FL-177), cloudMl{enabled, routing{descriptions, upscale, restoration, transcription, interpolation} (each one of local-only, both, cloud-only; default local-only), descriptions{enabled, defaultModel, autoBatch:false, dailyBudgetUsd}, restoration{enabled, defaultModel}, interpolation{enabled, defaultModel}, faces{enabled:false}}, cloudBackup{enabled, target:'off'|'managed'|'byo-s3', s3{endpoint,region,bucket,accessKeyId,secretAccessKey (write-only)}, keyMode:'server'|'own-stored'|'own-memory', bucketKey (write-only credential `cloud-backup-bucket-key`, absent in own-memory mode), schedule{cronExpression:'0 3 * * *'}, retention{keepDaily:7,keepWeekly:4,keepMonthly:12}, include{thumbs:false,encodedVideo:false}, verifyWeekly:true, escrow:false}}` (schema-level `.default()` everywhere); **remove** the previous GPU-provider integration's `machineLearning` section (keep `hfToken` only if the local ML container needs it for gated model downloads — verify). `system-config.service.ts` `ConfigValidate`: remote access needs link + entitlement; byo-s3 needs endpoint/bucket.
- `server.service.ts`/`server.controller.ts`: delete `server/license` routes (and from `ADMIN_ROUTES` in `controllers/index.spec.ts`); `getAboutInfo().licensed = state ∈ {active, grace}`; `getFeatures()` + `ServerFeaturesSchema` add `frameleafCloud, remoteAccess, cloudMl, cloudBackup, supporter`; `getSystemConfig(via)` adds `frameleaf{via, signInAvailable, signInRequired, publicUrl}`; new `GET server/connections` (Plex `connections[]` shape). `app.controller.ts` `/.well-known/immich` adds `frameleaf{instanceId, publicUrl, signIn}`. `PublicConfigDto` adds `frameleaf{signInAvailable, signInRequired, via}`.
- `user.service.ts`/`user.dto.ts`/`user.controller.ts`: replace IMCL with `UserSupporterSchema {kind:'individual', keyHint, activatedAt}` (DTO id `UserLicense` kept; protocol change recorded for native apps); `dtos/license.dto.ts` re-exports; remove `config.repository.ts` FUTO keys, `emails/license.email.tsx` my.immich.app link (rewrite or delete), `helmet.json` pay.futo.org CSP.
- `auth.service.ts`: `callback()` requires `email_verified===true` for email-linking and auto-register; `authenticate()` enforcement (relay/WAN: shared link ok; session must be Frameleaf-tagged; API key only if owner linked; else 403 `frameleaf_sign_in_required`); `login()` refuses password over relay/WAN unless `allowPasswordOverRelay`; back-channel logout accepts `aud===instanceId` (Frameleaf JWKS); extract `createSession()` for `FrameleafAuthService`. `auth.guard.ts` passes `request.frameleafVia`. Originals/downloads/DB backups refuse `via==='relay'` unless `allowOriginalsOverRelay`.
- `websocket.repository.ts`: `cors` → origin allow-list (same-origin, `server.externalDomain`, published names); `on_frameleaf_cloud {topic}` to admins; handshake `frameleafVia`. `shared-link.service.ts`: bcrypt passwords, `timingSafeEqual` tokens (+ migration 630). `user.repository.ts` `getAdmins()`; `notification.service.ts` `notifyAdmins({…, dedupeKey, dedupeDays≤30})` + `findRecentByDedupeKey`; the previous GPU-provider integration's service deleted (its `notifyAdmin` callers move to `notifyAdmins`).
- ML: `utils/ml-destination.ts` (`resolveEndpoint` sentinel for the cloud kind; `workloadPolicyProblem` allows Mixed only for FrameleafCloud restricted to `enrichment|upscale|restoration-*|studio-ai|interpolation` (Studio exports stay local; Smooth motion at export is its own interpolation job); `evaluateAdmission` adds the new refusals from the probe; pre-flight `hold ≤ balance` for every cloud job; per-workload routing `local-only`/`both`/`cloud-only` where `both` means the job picks at confirmation and a job is never moved to the cloud silently), `machine-learning.repository.ts` (`probe()` delegates for the cloud kind; `MlEndpoint.kind`), `ml-destination.service.ts` (cloud row created only by `POST admin/cloud/ml/destination`; no url/token fields; restoration models from the catalog), `asset-restoration.service.ts` + dto (cloud branch: `estimate.cloudCost` filled as GPU time × rate + start fee with per-unit estimates, model slider, `consentVersion` + `acknowledgeDataLeaves`; new interpolation operation), `enrichment-plan.service.ts`/`image-enrichment.service.ts` (description stage → cloud batches; prompt privacy: `identityInjection`/`medical` off unless consent features allow), `restoration-worker.service.ts` (`-map_metadata -1 -map_chapters -1` on preview/chunk cuts; re-encode web-native originals for cloud, strip EXIF/GPS, keep ICC), `ml_workload_accounting.costUsd` filled from settlements (+ `credits`, `cloudJobId`), `ml_workload_route.modelId`, `ml_destination.region/consentVersion` (in migration 620). Delete the previous GPU-provider integration (locate it from the two cloud kinds in `CLOUD_ML_DESTINATION_KINDS`): its repository, service and controller, its admin settings components under `components/admin-page/settings/machine-learning/`, and its docs and i18n.
- Backup agent (`cloud-backup.service.ts`): bucket claim (`frameleaf-backup.json` root marker with instance id;
  refuse foreign/claimed buckets; one bucket per server); per-bucket key in three modes (server / own-stored /
  own-memory) with `POST admin/cloud/backup/key/unlock` for own-memory after restarts; run = `media_operation`
  kind `cloud_backup`: (1) `createDatabaseBackup()` → `db/<file>.sql.gz` (keep last N), (2) walk assets by
  `immich_fork.asset_checksum` + sidecars/profile (sha256 on the fly), skip every hash present in
  `cloud_backup_object` (or in a fresh bucket listing on first run), upload the rest as `o/<sha256>` with SSE-C
  (multipart 8 MiB, `Content-MD5`, verify ETag), (3) write manifest `m/<ISO>.json.gz` (asset id → hash, path,
  size, mtime, sidecar hash, owner), (4) retention: keep daily/weekly/monthly manifests, delete objects not
  referenced by any kept manifest; lease, cursor every 25 assets, pause/resume/cancel, resume by manifest id;
  weekly verify = sampled GET + sha256 of 1/52 of objects, monthly HEAD of all referenced hashes; restore =
  pick manifest → download by hash with SSE-C → verify → `<media>/frameleaf/restore/<id>` (Library Care) or
  `<media>/backups` (maintenance DB restore) or per-asset restore; `commands/cloud-backup.command.ts`
  (`immich-admin cloud-backup restore --bucket … --key-file …`).
- Registration arrays (`services/controllers/repositories index.ts`), `schema/migrations/ORDER` (`migrations:sync-order`), `fork-schema/manifests/fork-v2-catalog.json` regen, `catalog.spec.ts` counts (177 → 181), `migration-ledgers.spec.ts` names, `mise run //:sql`, OpenAPI + SDK regen.

### A4. Web changes

- Navigation: `lib/frameleaf/settings-areas.ts` new area `cloud` (group `server`, after `server`) with sections `cloud-account, plan, license, remote-access, cloud-ml, cloud-backup` (Plan and Licence are separate pages; every section row has an icon; copy is plain language, outcome first, no internal terms, per the prototype and FL-10) + personal `frameleaf-account`, `AREA_TILE_COLORS.cloud`, `DIRECTORY_GROUPS.cloud` (`account_link|licensing|remote|cloud_services`); `SettingsHost.svelte` `areaCopy.cloud`; `sections/SectionBody.svelte` branches; `personal-sections.ts` + `UserSettingsList.svelte` (`frameleaf-account` gated by `featureFlagsManager.value.frameleafCloud`); `command-index.ts`; `CommandCenterOverview.svelte` "Frameleaf Cloud" glance tile (replaces "Cloud destination"); `AccountMenu.svelte` Frameleaf pill; `MlDestinationsPanel.svelte` cloud row (no URL/token; consent + budget kept; wallet instead of hourly rate).
- New: `lib/managers/cloud-manager.svelte.ts` (admin-only, subscribes `on_frameleaf_cloud`, reloads on `SystemConfigUpdate`), `lib/frameleaf/cloud.ts` (pure helpers incl. `validateProductKey` port of `system-data.mjs:684-705`, `storeUrl`), `components/frameleaf/cloud/{CloudAccountSection, PlanSection, LicenseSection, LicenseActivateDialog, LicenseFileDialog, RemoteAccessSection, CloudMlSection, CloudMlConsentDialog, CloudMlWalletCard, CloudMlModelSlider, HardwareGpuSection, CloudBackupSection, CloudBackupSetupDialog, CloudBackupRestoreDialog, RecoveryKitPanel}.svelte`, `components/frameleaf/access/FrameleafAccountSection.svelte`, `components/frameleaf/buy/{BuyScreen, BuyPlanCard, BuyKeyField, BuyActivated}.svelte + buy.css` (port of `AuthScreens.jsx:1400-1620`: "Support Frameleaf", plan cards for the subscription, supporter cards one-time, "Already have a key?", activated card, "Hide the supporter badge" switch, Remove key in place), onboarding `OnboardingFrameleafAccount.svelte` + `OnboardingLicense.svelte` (SERVER steps after `storage_template` in `lib/frameleaf/onboarding.ts`; e2e "Step 11 of 11").
- Routes: `(user)/buy/+page.svelte` mounts `BuyScreen`; `+page.ts` reads `sessionStorage['frameleaf:license:pending']`; `routes/link/+page.ts` handles `#target=frameleaf_license&key=…` (fragment only; `history.replaceState`) and `?target=frameleaf_account` (avoids the `?code=` OAuth-return gotcha); login page "Sign in with Frameleaf" (only that button when `signInRequired`), LAN bounce.
- Delete: `shared-components/purchasing/*`, `lib/utils/license-utils.ts`, `PUBLIC_IMMICH_BUY_HOST/PAY_HOST` (`web/svelte.config.js:7-8`, `app.d.ts`), `side-bar/PurchaseInfo.svelte` mount, the previous GPU-provider integration's settings panel.
- i18n (`i18n/en.json`, sorted): `frameleaf_cloud_*`, `frameleaf_license_*`, `frameleaf_remote_*`, `frameleaf_settings_area_cloud*`, `frameleaf_cc_group_{account_link,licensing,remote,cloud_services}`, audit sentences, activity kinds; `buy` → "Support Frameleaf"; drop `purchase_*` (27 keys), `frameleaf_access_server_key_product_name`, every "the GPU provider" string (closes audit B-1..B-9, S-31, B-9).
- Activity: every job shows its stage — Queued → Starting → Running → Done / Failed / Cancelled / Paused — with an In progress section, background server work (read-only; pause, retry and limits live in Settings → Background work) and cloud backup runs; `ActivityItem.cost {estimatedUsd, soFarUsd, settledUsd|null}`, `model`, `stage`, kinds `cloud_ml_job|cloud_backup|cloud_restore`.
- Remote access page: status, relay/direct, the Public server URL choice (moved here from Server identity: "Use the Frameleaf address" / "Use my domain") and the custom hostname card (records to add, DNS check pending → verified, certificate state). Account & link states the benefit "Access your library from the Frameleaf mobile apps from anywhere". Cloud backup setup starts with "Generate a key for me" or "I'll maintain my own key".
- Docs: new `docs/docs/administration/frameleaf-cloud.md`; update `guides/remote-access.md`, `administration/workers-and-endpoints.md` (edge worker; Frameleaf Cloud destination; no the GPU provider), `system-settings.md`, `features/user-settings.md`, `FAQ.mdx`, `install/environment-variables.md`; Confluence mirror + documentation-coverage re-pin.

### A5. Edge worker (implementation notes)

`EdgeStateService` polls desired state every 10 s (config `frameleafCloud.remoteAccess.enabled` ∧ link ∧
entitlement active/grace), writes `SystemMetadataKey.FrameleafRemoteAccess`, publishes candidates
(`PUT /v1/instance/endpoints`), tears down on `AppShutdown`. `EdgeCertificateRepository`: `acme-client`,
account key + certs under the identity dir (0600), DNS-01 through the cloud TXT API, wait for propagation
via the cloud's resolver hint, renew daily with 0–6 h jitter when remaining < max(25 d, ⅓ lifetime), retry
1 h → 24 h with a deduped admin notice. `EdgeProxyService`: one `http.createServer` (never listened) +
`upgrade`; strips client `x-frameleaf-*`, injects the via contract, pipes unbuffered (24-h request timeout,
Range, chunked), HSTS; caps 512 connections / 64 per IP. `EdgeDirectService`: `tls.createServer` on
`FRAMELEAF_EDGE_BIND:FRAMELEAF_EDGE_PORT`, peer RFC 1918/ULA (or trusted CIDRs) → `via: lan` else `wan`;
`@achingbrain/nat-port-mapper` (UPnP then NAT-PMP/PCP), lease 3600 s refreshed every 30 min, unmap on
disable; external IP vs heartbeat `observed_ip` → `cgnatSuspected`; WAN candidate `verified` only after
`POST /v1/remote/probe`; bridge networking → documented guidance (host networking or manual port).
`EdgeRelayService`: token → `tls.connect` (SNI `tun.<relay>`, ALPN `fl-tunnel/1`) → handshake → h2 server
over the socket → `CONNECT` streams → `TLSSocket` per stream → proxy core with `via: relay`; PING 30 s (3
misses reconnect), full-jitter backoff 1 s → 5 min, refresh token at 50 %, re-select relay after 3
failures. Public URL `https://r.<label>.frameleaf-direct.net` — or a verified custom hostname on the owner's domain (CNAME
`<host>` → `r.<label>.frameleaf-direct.net`, CNAME `_acme-challenge.<host>` → `_acme-challenge.<label>.frameleaf-direct.net`,
so the cert for `<host>` is issued and renewed on the server through the same TXT API; the relay routes the SNI) — exposed via `/server/config`,
`/.well-known/immich`, `/server/connections` (candidate order local → wan → ipv6 → relay).

### A6. Delivery slices (each a `codex/FL-<n>-slug` PR, off until linked; reviewer required where marked ★)

1. **Instance identity + cloud deployment config** — identity repo, env, `request()`, `GET admin/cloud/status`, `cloud` area skeleton. AC: identity created once (PEM 0600, RFC 7638 `kid`), no outbound call without link, unset URL ⇒ "not configured" never a fallback.
2. **Link a server (device flow, link token, heartbeat, unlink)** — AC: code + QR flow; headless single-use token; unlink leaves no secret; heartbeat matches the "what we send" panel; audit rows.
3. ★ **License certificates replace the product key** — pinned keys (+spare), refresh job/grace/notices, feature flags, `About.licensed`, supporter tables, IMSV/IMCL removal. AC: spare-key cert verifies; bad `kid`/`sub`/tamper refused; grace keeps entitlements; offline file install works; `ADMIN_ROUTES` updated; OpenAPI/SDK regen.
4. **Support Frameleaf screen and key relay** (`/buy`, `/link`; closes B-1..B-9) — AC: key never in a query string (Playwright asserts); prototype states match; onboarding `license` step; i18n cleanup.
5. ★ **Sign in with Frameleaf (second provider slot)** — `email_verified` patch, fork tables, back-channel logout, login button, personal section, onboarding `frameleaf_account`. AC: unverified email refused for all providers; coexists with an admin's own IdP; tagged sessions; cloud logout kills them; mobile override rewrites to `frameleaf-auth:///oauth-callback`.
6. ★ **Remote-access security prerequisites** — rate limits, shared-link password hashing (+630), websocket origin check, via-middleware + supervisor secret, `authenticate()` rule, originals-over-relay refusal. AC: client `X-Frameleaf-Via` dropped; rule enforced; old plaintext links keep working; login throttled.
7. **Edge worker: certificate + direct listener** — AC: idle without link; cert issued via mocked TXT API (also for a verified custom hostname); LAN name serves HTTPS with `via: lan`; teardown ≤ 5 s.
8. ★ **Edge worker: blind relay tunnel** — AC: fake relay harness (Node `http2.connect` over a socket pair) round-trips HTTP + WebSocket; token refresh; PING misses reconnect; originals refused by default.
9. **Edge worker: port mapping, WAN candidate, LAN→relay sign-in bounce** — AC: lease refresh/unmap; bridge guidance; handoff child session lands on the LAN origin.
10. ★ **Frameleaf Cloud as the processing destination (replaces the GPU provider)** — kind, migration 620 (gpu-provider rows deleted), policy/admission, job client probe/catalog/wallet/consent, `CloudMlSection`, the GPU provider code/config/docs/i18n removed, Hardware & GPU check, per-workload routing, colour-banded model slider. AC: destination only by explicit admin action; a job never moves to the cloud silently; faces refused; admission refuses on missing/outdated consent, empty wallet, cloud unreachable — never falls back; no "the GPU provider" string remains in customer copy (spec greps `i18n/en.json`, `docs/`); Studio export rendering is never a cloud workload.
11. ★ **Cloud restoration/upscaling and Smooth motion jobs** (`media_operation` kind `cloud_ml_job`; estimate → confirm → submit → progress → result; model slider; per-job consent; cancel releases hold; refunds; Activity cost). AC: estimate shown as GPU time × rate + start fee with per-unit estimates before confirm and settled cost after; long video chunked 20–30 s across ≤ 5 serverless workers; resume by `cloudJobId`; 402 refuses without downgrade; Activity shows each job's stage (Queued → Starting → Running → Done / Failed / Cancelled / Paused).
12. **Cloud description batches** (`CloudMlBatchService`, one run per batch, daily budget, Library-care wording). AC: never one run per asset; estimate by GPU time; budget exhaustion notifies once.
13. ★ **Cloud backup: bucket claim, per-bucket key modes, content-addressed manual runs** — AC: bucket claimed once and refused if foreign; setup asks "Generate a key for me" / "I'll maintain my own key" first; key modes server/own-stored/own-memory behave as specified; every object uploaded with SSE-C; a second run uploads nothing when nothing changed; duplicates on the same server produce one object; run survives restart.
14. ★ **Cloud backup: schedule, retention, verification, managed Wasabi, escrow, restore + CLI** — AC: single scheduler; runs show their stage and progress in Activity; retention prunes only unreferenced objects; over-quota → read-only; restore by manifest verifies every hash; DB restore via existing maintenance flow.
15. **Command Center polish, onboarding, docs, Confluence** — AC: no "fork"/"DTO"/"Immich" product copy; Public server URL lives in Remote access; every section row has an icon and plain-language copy; every section searchable; docs list env + credentials.

Specs that must change: `controllers/index.spec.ts`, `server.service.spec.ts`, `user.service.spec.ts`,
`auth.service.spec.ts`, `shared-link.service.spec.ts`, `notification.service.spec.ts`,
`ml-destination.service.spec.ts`, `asset-restoration.service.spec.ts`, `config.repository.spec.ts`,
`fork-schema/catalog.spec.ts`, `migration-ledgers.spec.ts`, `ml-destination.repository.spec.ts`,
`SettingsHost.spec.ts`, `CommandCenterOverview.spec.ts`, `PersonalAccessDialogs.spec.ts`, onboarding
`page.svelte.spec.ts`, `e2e/src/specs/web/auth.e2e-spec.ts:53`, `e2e/src/ui/mock-network/base-network.ts`,
`open-api/immich-openapi-specs.json` + `packages/sdk`, `server/src/queries/*.sql`; delete the previous GPU-provider integration's service spec.

## 11. Deliverable: the plan as Jira epics/stories (FL + FC) and Confluence pages (FR + FC)

The owner's instruction (2026-09-25): create the plan for the open-source fork in Jira **FL** and for the
cloud in Jira **FC**, mirror the plan to Confluence (**FR** for the fork, **FC** for the cloud), and write
every epic and story for AI coding agents in the format the FL board already uses.

Verified targets: Jira FL (id 10232) and FC (id 10233), both with Epic 10000 / Story 10039 / Task 10118;
only `summary`, `project`, `issuetype` are required — `parent` and `labels` go in `additional_fields`;
link types `Blocks` (inward = blocker) and `Relates`. Confluence FR (space id 61374475; implementation-plan
parent page 61538319; agent guide 61407516) and FC (space id 63733763; home page 63733939, still the
template text). Site `heroit.atlassian.net`.

### 11.1 Conventions (apply to every issue)

- Summary `[PLAN-ID] Title`; labels `[<PLAN-ID>, frameleaf-cloud]`; parent = the epic key; priority Medium
  unless marked High; status To Do at creation; no assignee, no estimates or dates.
- Plan IDs are stable join keys. FL workstream `cloud`: epics `CLD-E01..E04`, stories `CLD-0nn/1nn/2nn/3nn`.
  FC workstreams: `OPS`, `IDN`, `INS`, `ENT`, `WAL`, `REM`, `BAK`, `MLC`, `WEB` with epics `XXX-E0n` and
  stories `XXX-nnn`.
- Copy rule in every issue: say "Frameleaf Cloud", never "the GPU provider"; customer-facing copy never says
  "fork", "DTO", "worker-admission proof" or names Immich as the product.
- Dependencies become `Blocks` links (inward = prerequisite) using the transitive reduction, exactly like
  `jira-map.json`; cross-project dependencies use `Blocks` too; informational overlaps use `Relates`.
- Fork-side stories also get `backlog.json` records (exact keys: `acceptance, dependencies, epicId,
executionGuide, id, objective, paths, phase, priority, risks, sourcePhase, status, tests, title, type,
workstream, workstreamGuide`; `workstream: "cloud"`, `workstreamGuide:
docs/docs/developer/frameleaf-plan/15-frameleaf-cloud-integration.md`, `status: planned-not-qualified`,
  `phase: 4`, `sourcePhase: "P1"`), `jira-map.json` entries and a `topologicalOrder` update; the validator
  `scripts/frameleaf-delivery-backlog-contracts.mjs` counts (142 items / 24 epics / 118 stories) and
  `delivery-backlog-evidence.json` are re-observed in the same PR (CLD-000).

### 11.2 Story description template (agent-facing; identical structure to FL-67/FL-80)

```
<Objective: one or two sentences.>

[Program plan](<FR page: Frameleaf Cloud program plan>) · [Agent execution guide](https://heroit.atlassian.net/wiki/spaces/FR/pages/61407516/AI+Coding+Agent+Execution+Guide) · [Workstream specification](<FR or FC page for this workstream>)

Repository: https://github.com/Frameleaf/frameleaf-app | https://github.com/Frameleaf/frameleaf-cloud. Read root AGENTS.md before work. Source anchors refer to the inspected working tree; preserve pre-existing changes and verify the current baseline (fork: refetched `master/frameleaf-implementation`).

Plan ID: `<ID>`. Stage <n>. Status at creation: planned, not qualified. No estimate or delivery date is implied.

## Scope and source anchors
* <paths>
## Acceptance criteria
* <bullets>
## Validation and evidence
* <bullets; hosted CI only, never full builds on the operator's Mac>
## Risks and boundaries
* <bullets>
## Depends on
* [<KEY>](<url>) — `<PLAN-ID>`
## Design reference
* <Confluence page + section>; naming rule: "Frameleaf Cloud", never the previous GPU provider's name; prototype anchors where the design/frameleaf template covers the screen (authoritative), otherwise apple-style patterns.
## Agent completion contract
Retain source feature behavior and owner/privacy rules. Implement real production behavior, error/recovery paths and required web/worker counterparts. Update the requirement ledger, docs and evidence. A prototype control or a generated client is insufficient. Keep this issue open while required acceptance is missing or unqualified. Break work into reviewed child tasks when necessary without reducing parent acceptance. Do not deploy, publish, push upstream or push to origin from this ticket alone.
```

Epic template = FL-10's: objective, the same links line, repository line, Plan ID + Stage, "## Scope and
source anchors", "## Acceptance criteria" ("Every child issue has production evidence and preserves the
source actions named in its acceptance criteria"; "Nothing is enabled or contacted before the admin opts
in"), "## Validation and evidence", "## Risks and boundaries", "## Agent completion contract".

### 11.3 FL (open-source fork) — epics and stories

Stages: 3 = foundation, 4 = feature. All stories: repository frameleaf-app; base = refetched
`master/frameleaf-implementation`; branch `codex/FL-<n>-<slug>`; ★ = independent reviewer required.

**CLD-000 (Task) Register the Frameleaf Cloud workstream** — objective: land the design as repo-owned docs and
backlog records before any feature work. Anchors: `docs/superpowers/specs/2026-09-24-frameleaf-cloud-design.md`
(new, prettier-clean), `docs/docs/developer/frameleaf-plan/15-frameleaf-cloud-integration.md` (new workstream
guide: contracts, module map, slices), `backlog.json`, `jira-map.json`, `delivery-backlog-evidence.json`,
`scripts/frameleaf-delivery-backlog-contracts.mjs`, `confluence-mirror.json`, `docs/docs/developer/frameleaf-plan/00-implementation-plan.md`
(one paragraph + link). AC: validator passes with the new counts; every CLD item has a Jira key in `jira-map.json`;
FR mirror pages carry source path + SHA-256 + backlink and are read back; no "the GPU provider" in the new docs. Deps: none.

**CLD-E01 Frameleaf Cloud account, licensing and sign-in (self-hosted)** — Stage 3/4. Anchors: `server/src/services/auth.service.ts`,
`server/src/services/server.service.ts`, `server/src/dtos/config.dto.ts`, `web/src/lib/frameleaf/settings-areas.ts`,
`web/src/routes/(user)/buy`, `design/frameleaf/template/src/AuthScreens.jsx`. Overlaps: FL-10 (settings parent),
FL-67, FL-80, FL-131 (`Relates`).

- **CLD-001 Instance identity and Frameleaf Cloud deployment configuration** (Stage 3). Anchors:
  `server/src/repositories/instance-identity.repository.ts` (new), `server/src/repositories/frameleaf-cloud.repository.ts`
  (new), `server/src/dtos/env.dto.ts`, `server/src/repositories/config.repository.ts`, `server/src/enum.ts`,
  `server/src/types.ts`, `server/src/controllers/cloud-admin.controller.ts` (new), `web/src/lib/frameleaf/settings-areas.ts`,
  `web/src/lib/components/frameleaf/cloud/CloudAccountSection.svelte` (new), `docs/docs/administration/frameleaf-cloud.md` (new).
  AC: UUIDv7 `instanceId` + Ed25519 key created once under `DatabaseLock.FrameleafIdentity`, PEM 0600 under
  `FRAMELEAF_IDENTITY_DIR` default `<media>/frameleaf/identity`, `kid` = RFC 7638; `FRAMELEAF_CLOUD_URL`,
  `FRAMELEAF_IDENTITY_DIR`, `FRAMELEAF_LINK_TOKEN`, `FRAMELEAF_EDGE_PORT/BIND` parsed and documented; `GET admin/cloud/status`
  (`Permission.AdminCloudRead`, `ApiTag.FrameleafCloud`, `@Endpoint` history) reports not-configured/unlinked;
  Command Center area `cloud` (server group, after `server`) exists with the account section in its
  not-configured state; **no outbound request is made without a link** (spec asserts `fetch` unused); unset URL
  ⇒ "not configured", never a fallback. Validation: `instance-identity.repository.spec.ts` (tmp dir, `wx` race),
  `frameleaf-cloud.repository.spec.ts` (timeout, allow-listed upstream errors), `settings-areas.spec.ts`,
  `command-index.spec.ts`, `SettingsHost.spec.ts`; OpenAPI + SDK regen. Risks: cloud URL is deployment config,
  never a setting (FL-71 rule). Deps: CLD-000.
- **CLD-002 Link a server to a Frameleaf account (device flow, link token, heartbeat, unlink)** (Stage 4).
  Anchors: `server/src/services/frameleaf-cloud.service.ts` (new), `server/src/dtos/frameleaf-cloud.dto.ts` (new),
  `server/src/repositories/user.repository.ts` (`getAdmins`), `server/src/services/notification.service.ts`
  (`notifyAdmins` + dedupe), `server/src/repositories/websocket.repository.ts` (`on_frameleaf_cloud`),
  `web/src/lib/managers/cloud-manager.svelte.ts` (new), `CloudAccountSection.svelte`. AC: `POST/GET/DELETE
admin/cloud/link` implement RFC 8628 against the cloud (user code + `verification_uri_complete` + QR; server-side
  polling honours `interval`/`slow_down`/`expired_token`/`access_denied`); `FRAMELEAF_LINK_TOKEN` links once
  headlessly; heartbeat cron (5 min + jitter) under `DatabaseLock.FrameleafHeartbeat` sends exactly the fields
  shown in the "What we send" panel; commands honoured only when the instance permission toggles allow; unlink
  from either side leaves no secret (credential cleared, link `revoked`, remote/ML/backup desired-state false);
  every link/unlink/revoke is an admin audit row; admins get deduped notices; the Account & link page states the
  benefit "Access your library from the Frameleaf mobile apps from anywhere". Validation: service state-machine
  spec with a fake cloud, notification dedupe spec, Playwright `ui` with `e2e/src/ui/mock-network/cloud-network.ts`.
  Risks: revoke command must never delete local data. Deps: CLD-001, FC INS-001, FC INS-002.
- ★ **CLD-003 Frameleaf license certificates replace the Immich product key** (Stage 4). Anchors:
  `server/src/utils/frameleaf-license.ts` (new), `server/src/services/frameleaf-license.service.ts` (new),
  `server/src/controllers/license-admin.controller.ts` (new), `server/src/dtos/frameleaf-license.dto.ts` (new),
  `server/src/constants.ts` (pinned Ed25519 keys + spare), `server/src/services/server.service.ts`,
  `server/src/controllers/server.controller.ts`, `server/src/services/user.service.ts`, `server/src/dtos/user.dto.ts`,
  `server/src/dtos/license.dto.ts`, `server/src/repositories/config.repository.ts`, `server/src/emails/license.email.tsx`,
  `server/helmet.json`, `server/src/fork-schema/migrations/0000000000190-FrameleafUserLicenses.ts` (new),
  `web/src/lib/components/frameleaf/cloud/LicenseSection.svelte` (new). AC: `GET admin/license` returns
  `LicenseStatusResponseDto {state none|active|grace|expired|invalid, kind, keyHint, expiresAt, graceUntil,
fingerprint, entitlements{remoteAccess,cloudMl,cloudBackup,supporter}, refresh, offline}`; `PUT admin/license/activate
{key}` (`FL-KXXX-XXXX-XXXX`, check symbol), `PUT admin/license/certificate` (offline file), `DELETE`, `POST …/refresh`;
  certificates verified with pinned keys (spare key verifies; unknown `kid`, wrong `sub`, tampered payload refused);
  daily refresh with jitter, grace keeps entitlements with `state: grace`, past grace ⇒ flags false, **data untouched**;
  `ServerFeaturesDto` gains `frameleafCloud, remoteAccess, cloudMl, cloudBackup, supporter`; `About.licensed` =
  active|grace; IMSV/IMCL code, FUTO keys, `pay.futo.org` CSP and the `server/license` routes removed (also from
  `ADMIN_ROUTES`); per-user supporter keys stored in `immich_fork.frameleaf_user_license`; Licence is its own page, separate from Plan; a
  licensed server (server or individual supporter key) gets 20 % off Frameleaf Cloud plans only — AI credit is never
  discounted (every run keeps ≥ 100 % over loaded cost). Validation: key/cert
  vectors spec, rewritten `server.service.spec.ts` + `user.service.spec.ts`, `controllers/index.spec.ts`, medium spec
  - catalog/ledger counts, OpenAPI/SDK regen. Risks: `UserAdminResponseDto.license` shape change is a recorded
    protocol change for the native rebuild. Deps: CLD-001, FC ENT-002.
- **CLD-004 Support Frameleaf screen and license relay (`/buy`, `/link`)** (Stage 4; closes audit B-1..B-9, S-31).
  Anchors: `web/src/lib/components/frameleaf/buy/{BuyScreen,BuyPlanCard,BuyKeyField,BuyActivated}.svelte` (new),
  `web/src/routes/(user)/buy/+page.{svelte,ts}`, `web/src/routes/link/+page.ts`, `web/src/lib/components/frameleaf/access/SupporterSection.svelte`,
  `web/src/lib/components/frameleaf/AccountMenu.svelte`, `web/src/lib/frameleaf/onboarding.ts`,
  `web/src/routes/auth/onboarding/OnboardingLicense.svelte` (new), `web/svelte.config.js`, `i18n/en.json`,
  `design/frameleaf/template/src/AuthScreens.jsx:1400-1620`, `system-data.mjs:648-766`. AC: prototype states
  ported (Support Frameleaf heading, subscription plan cards, one-time supporter cards, "Already have a key?" with
  `FL-` validation, activated card with key/date/badge, hide-badge switch with correct sense, Remove key in place,
  Back + wide auth shell); Plan and Licence are separate settings pages; plan prices show the 20 % licensed-server
  discount when licensed, AI credit top-ups never do; keys travel only in `#fragment`/`sessionStorage`/POST body (Playwright asserts no
  `licenseKey=` in any URL); `GET license/products` returns bundled prices + deployment-configured store URL, no
  outbound call; onboarding SERVER step `license`; `purchase_*`, `buy` and Immich product-name keys removed;
  `shared-components/purchasing/*`, `license-utils.ts`, `PUBLIC_IMMICH_*` deleted. Validation: `BuyScreen.spec.ts`,
  `cloud.spec.ts`, ui `buy.e2e-spec.ts`, `auth.e2e-spec.ts` step count. Deps: CLD-003.
- ★ **CLD-005 Sign in with Frameleaf (second OIDC provider slot)** (Stage 4). Anchors:
  `server/src/services/frameleaf-auth.service.ts` (new), `server/src/controllers/frameleaf-auth.controller.ts` (new),
  `server/src/services/auth.service.ts` (`callback()` `email_verified`, `createSession()` extraction, back-channel
  branch), `server/src/repositories/frameleaf-account.repository.ts` (new), fork migrations `0000000000170-FrameleafAccountLinks`,
  `0000000000180-FrameleafSessions`, `server/src/dtos/config.dto.ts` (`frameleafCloud.signIn`; the
  `frameleaf-oidc-client-secret` credential was removed by FL-177), `web/src/routes/auth/login/+page.svelte`, `web/src/lib/components/frameleaf/access/FrameleafAccountSection.svelte` (new),
  `web/src/routes/auth/onboarding/OnboardingFrameleafAccount.svelte` (new). AC: `POST oauth/frameleaf/{authorize,callback,handoff,link}`
  - `GET/DELETE oauth/frameleaf/link` reuse `OAuthRepository` with a runtime-derived config (issuer from discovery,
    `clientId = instanceId`, `storageLabelClaim ''`, `roleClaim frameleaf_role`); **unverified email refused for every
    provider**; an account linked to the admin's own IdP can also link Frameleaf; sessions created here are tagged in
    `immich_fork.frameleaf_session`; cloud back-channel logout kills them; mobile override rewrites to
    `frameleaf-auth:///oauth-callback`; `PublicConfigDto.frameleaf{signInAvailable, signInRequired, via}` drives the
    login page. Validation: `auth.service.spec.ts`, `frameleaf-auth.service.spec.ts`, medium specs, web login spec,
    ledger/catalog counts. Risks: never preset `oauth.*`. Deps: CLD-002, FC IDN-002, FC IDN-003.
- **CLD-006 Command Center polish, onboarding and documentation for Frameleaf Cloud** (Stage 4). Anchors:
  `web/src/lib/components/frameleaf/settings/CommandCenterOverview.svelte`, `web/src/lib/frameleaf/command-index.ts`,
  `web/src/routes/(user)/user-settings/personal-sections.ts`, `docs/docs/{administration,guides,features}/**`,
  `docs/docs/FAQ.mdx`, `docs/docs/install/environment-variables.md`, `confluence-mirror.json`. AC: "Frameleaf Cloud"
  glance tile (link state · remote on/off · license state); the Public server URL setting moves from Server identity
  to Remote access ("Use the Frameleaf address" / "Use my domain"); every settings section row has an icon and settings
  copy is plain language (outcome first, no internal terms) as prototyped (FL-10); every cloud section reachable from search and deep links;
  docs list every env var and credential; no "fork"/"DTO"/"Immich"-as-product/"the GPU provider" in customer copy (grep test);
  Confluence mirrored in the same pass. Deps: CLD-004, CLD-005, CLD-104, CLD-203, CLD-302.

**CLD-E02 Remote access: edge worker, relay and direct connect (self-hosted)** — Stage 4. Anchors:
`server/src/main.ts`, `server/src/app.common.ts`, `server/src/edge/**` (new), `server/src/services/auth.service.ts`,
`server/src/repositories/websocket.repository.ts`, `docs/docs/guides/remote-access.md`.

- ★ **CLD-101 Remote-access security prerequisites**. Anchors: `server/src/middleware/rate-limit.guard.ts` (new),
  `server/src/middleware/frameleaf-via.middleware.ts` (new), `server/src/schema/migrations/2100000000630-HashSharedLinkPasswords.ts` (new),
  `server/src/services/shared-link.service.ts`, `server/src/services/auth.service.ts`, `server/src/middleware/auth.guard.ts`,
  `server/src/repositories/websocket.repository.ts`, `server/src/main.ts` (`FRAMELEAF_EDGE_SECRET`). AC: ioredis
  rate limits on login, OAuth callbacks, `oauth/frameleaf/*`, shared-link login, license activation, link start,
  plus a per-IP ceiling for `via ∈ {relay, wan}`; shared-link passwords bcrypt-hashed with `timingSafeEqual` tokens
  and existing links keep working after migration; websocket `cors` → origin allow-list; client-supplied
  `X-Frameleaf-*` headers dropped, secret-authenticated ones set `request.frameleafVia`; enforcement in
  `authenticate()`: relay/WAN requires a Frameleaf-tagged session (shared links pass; API keys pass only when the
  owner is linked) else 403 `frameleaf_sign_in_required`; originals/archives/DB backups refused over relay unless
  `allowOriginalsOverRelay`; `ServerConfigDto.frameleaf` + `/.well-known/immich` fields. Validation: middleware,
  guard (ioredis mock), `auth.service.spec.ts`, `shared-link.service.spec.ts`, `sql-schema-up-to-date`. Deps: CLD-005.
- **CLD-102 Edge worker: certificate and direct listener**. Anchors: `server/src/workers/edge.ts` (new),
  `server/src/edge/{edge.module,edge-state.service,edge-certificate.repository,edge-proxy.service,edge-direct.service}.ts` (new),
  `server/src/enum.ts` (`ImmichWorker.Edge`, `DatabaseLock.FrameleafEdge`), `server/src/dtos/config.dto.ts`
  (`frameleafCloud.remoteAccess`), `server/src/controllers/server.controller.ts` (`GET server/connections`),
  `web/src/lib/components/frameleaf/cloud/RemoteAccessSection.svelte` (new), `server/package.json` (`acme-client`).
  AC: edge forked like `Api`, inert until linked + entitled + enabled; ACME DNS-01 via the cloud TXT API issues the
  wildcard cert (account key + cert key never leave the host; renew < max(25 d, ⅓ lifetime) with jitter; deduped
  notice on failure); HTTPS listener on `FRAMELEAF_EDGE_PORT` proxies to `127.0.0.1:${IMMICH_PORT}` with
  `X-Forwarded-*` + via contract, unbuffered bodies, upgrade, Range, HSTS; LAN name serves the web app with `via: lan`;
  disable/unlink removes cert and listener; `AppShutdown` closes sockets ≤ 5 s; `/server/config`, `/.well-known/immich`,
  `/server/connections` publish the public URL and candidates; **custom public hostname**: the owner adds CNAME `<host>` →
  `r.<label>.frameleaf-direct.net` and CNAME `_acme-challenge.<host>` → `_acme-challenge.<label>.frameleaf-direct.net`,
  a DNS check moves it pending → verified, then the server issues and renews the certificate for `<host>` via DNS-01
  through the delegated record and "Use my domain" makes it the public URL. Validation: proxy-core spec (headers/upgrade/range),
  certificate spec against a fake ACME directory, state spec, `PUT admin/cloud/remote` + `POST …/test`. Deps: CLD-101, FC REM-001.
- ★ **CLD-103 Edge worker: blind relay tunnel**. Anchors: `server/src/edge/edge-relay.service.ts` (new),
  `server/test/fixtures/relay.ts` (new harness). AC: relay token from `POST /v1/remote/relay-token`; outbound TLS
  (SNI `tun.<relay>`, ALPN `fl-tunnel/1`), handshake `AUTH → CHALLENGE → PROOF(Ed25519) → READY`, reversed HTTP/2
  server over the socket, one `CONNECT` stream per visitor connection terminated with `tls.TLSSocket` and proxied
  with `via: relay` and the relay-supplied client IP; PING 30 s (3 misses → reconnect), full-jitter backoff 1 s → 5
  min, token refresh at 50 %, re-select after 3 failures; `relay` candidate published; "relay disconnected" notice
  after 15 min (dedupe 24 h). Validation: harness round-trips HTTP + WebSocket, backoff spec, ui status panel spec.
  Deps: CLD-102, FC REM-002, FC REM-101.
- **CLD-104 Edge worker: port mapping, WAN candidate and LAN→relay sign-in bounce**. Anchors:
  `server/src/edge/edge-direct.service.ts`, `server/src/services/frameleaf-auth.service.ts` (`handoff`),
  `web/src/routes/auth/login/+page.svelte`, `server/package.json` (`@achingbrain/nat-port-mapper`),
  `docs/docs/guides/remote-access.md`. AC: UPnP then NAT-PMP/PCP mapping with lease refresh (30 min) and unmap on
  disable; manual public-port mode; external IP vs heartbeat `observed_ip` ⇒ `cgnatSuspected`; WAN candidate
  `verified` only after the cloud probe; bridge networking yields the documented guidance instead of silent
  failure; a LAN user signing in with Frameleaf lands back on the LAN origin with a tagged child session; a verified custom
  hostname is published as a candidate and used by the sign-in bounce like the Frameleaf address. Deps: CLD-103.

**CLD-E03 Frameleaf Cloud processing destination and AI Wallet (self-hosted)** — Stage 4. Anchors:
`server/src/utils/ml-destination.ts`, `server/src/services/ml-destination.service.ts`, `server/src/repositories/machine-learning.repository.ts`,
`server/src/services/asset-restoration.service.ts`, `server/src/services/image-enrichment.service.ts`,
`docs/docs/administration/workers-and-endpoints.md`. Overlaps: FL-42, FL-110, FL-114 (`Relates`; their
"the GPU provider" wording is superseded — comment on each).

- ★ **CLD-201 Frameleaf Cloud replaces the GPU provider destination**. Anchors: `server/src/enum.ts`
  (`MlDestinationKind.FrameleafCloud`, refusals, workloads), `server/src/schema/migrations/2100000000620-FrameleafCloudMlDestination.ts` (new;
  deletes the previous GPU-provider integration's rows and widens `ml_destination_kind_check` like `2100000000490`), `server/src/schema/tables/ml-destination.table.ts`,
  `server/src/repositories/frameleaf-cloud-ml.repository.ts` (new), `server/src/services/cloud-ml.service.ts` (new),
  `server/src/controllers/cloud-ml-admin.controller.ts` (new), `server/src/dtos/cloud-ml.dto.ts` (new),
  `server/src/dtos/config.dto.ts` (`frameleafCloud.cloudMl`; **remove the previous GPU-provider integration's `machineLearning` section**),
  delete the previous GPU-provider integration's server service, repository and controller and its web settings components under `web/src/lib/components/admin-page/settings/machine-learning/` (located via the two cloud kinds in `CLOUD_ML_DESTINATION_KINDS`),
  `web/src/lib/components/frameleaf/MlDestinationsPanel.svelte`, `web/src/lib/components/frameleaf/cloud/{CloudMlSection,CloudMlConsentDialog,CloudMlWalletCard,CloudMlModelSlider,HardwareGpuSection}.svelte` (new),
  `machine-learning/immich_ml` (hardware probe endpoint), `server/src/utils/ml-destination.ts`,
  `docs/docs/administration/workers-and-endpoints.md`, `i18n/en.json`. AC: the `frameleaf-cloud` row is created only
  by `POST admin/cloud/ml/destination` (no URL/token fields; auth = short-lived instance JWT `aud=ml`);
  `probe()` reads `/ping`, `/capabilities`, `/hardware` from the regional gateway; admission refuses on missing or
  outdated consent version, empty wallet (`WalletInsufficient`), entitlement missing, or cloud unreachable — **never
  a fallback**; faces refused by policy; versioned per-feature consent recorded in `immich_fork.frameleaf_consent`
  (`identityNames`, `medicalSignals` off by default); wallet card shows balance/holds and a top-up link only when the
  server returned one (top-ups $20 minimum, $25 default, presets $25 / $50 / $100); the GPU provider code, config,
  credentials, metadata keys, docs and strings are gone (spec greps `i18n/en.json` and `docs/`);
  `ml_workload_accounting.costUsd` populated from settlements. **Hardware check** (Compute & jobs → Hardware & GPU):
  probes the ML and server containers and reports per container whether a GPU is present, visible and usable
  (NVIDIA device nodes + `nvidia-smi`/NVML compute capability and the NVIDIA Container Toolkit, versus `/dev/dri` render
  nodes + render-group GID for Intel/AMD, `/dev/kfd` for ROCm, OpenVINO devices); each misconfiguration (toolkit
  missing, `video` capability missing, driver older than the image's CUDA, bf16/FlashAttention on Turing, `/dev/dri`
  not passed or GID mismatch, wrong render node, ROCm `HSA_OVERRIDE_GFX_VERSION`, WSL2, Unraid, CPU image tag on a GPU
  host, Docker on a Mac) shows a fix with a copy-ready compose snippet; a short benchmark per workload records
  throughput. **Per-workload routing** in "Where each job runs": Local only (default), Both (each job picks local or
  Frameleaf Cloud at confirmation) or Cloud only; a job is never moved to the cloud silently; search, faces and OCR
  are local only. **Model slider** per workload, light → heavy, colour-banded white = CPU, green = fits your GPU,
  blue = Frameleaf Cloud (from `/v2/catalog`), shown in "Where each job runs", Cloud processing, the per-job
  confirmation, the editor Enhance panel and Studio. As built (FL-186), Where each job runs and Cloud processing
  show the blue band only, from the live catalogue, and save the choice per model group apart from the routes; see
  "Model choice per model group" above. Studio exports render locally only (this server or a LAN
  worker) and are not a routable cloud workload. **Licence gate**: models whose licence forbids commercial hosted
  use never get a blue band; the slider shows each model's licence; faces stay local on InsightFace `buffalo_l` under
  the purchased commercial licence. **Pricing display**: GPU time × class rate + start fee, with per-photo/per-minute
  estimates as a p50–p90 range. Validation: `ml-destination` specs, migration in `sql-schema-up-to-date`, service spec
  with a fake gateway, hardware-probe fixtures per misconfiguration, slider colour-band spec, web specs, catalog
  regen. Deps: CLD-002, CLD-003, FC MLC-001.
- ★ **CLD-202 Cloud restoration and upscaling jobs (estimate → confirm → submit → progress → result)**.
  Anchors: `web/src/lib/components/asset-viewer/editor/VideoEditorPanel.svelte` (Enhance panel), `web/src/routes/(user)/studio/+page.svelte`, `server/src/services/cloud-ml.service.ts`, `server/src/services/asset-restoration.service.ts`,
  `server/src/dtos/asset-restoration.dto.ts`, `server/src/services/restoration-worker.service.ts` (`-map_metadata -1`,
  EXIF-stripped re-encode), `server/src/controllers/cloud-ml.controller.ts` (new), `web/src/lib/frameleaf/activity.ts`,
  `web/src/lib/components/frameleaf/ActivityView.svelte`. AC: job runs as `media_operation` kind `cloud_ml_job`
  (lease, cursor, pause/resume/cancel); estimate shown as "GPU time × rate + start fee" with per-photo/per-minute
  estimates (p50–p90, start fees included) and wallet balance before confirm; model slider (white/green/blue) from the
  catalog; restoration runs on serverless workers only, long video cut into 20–30 s chunks with a small overlap across
  at most 5 workers with a checkpoint per chunk (a lost worker costs at most one chunk, each worker adds one start fee);
  new **Smooth motion** frame-interpolation job (RIFE locally, FILM on Frameleaf Cloud) in the editor video Enhance panel
  and Studio for slow motion and export frame-rate conversion, preview-first (a short clip before the full job) and
  saved as a new version, never overwriting the original; Studio exports render locally only (this server or a LAN
  worker) and Smooth motion at export may run on Frameleaf Cloud as its own job; per-job consent text + `acknowledgeDataLeaves`; multipart uploads to presigned URLs;
  long-poll progress; sha256-verified results; cancel releases the hold; provider failure refunds; 402 refuses
  without downgrading; restart resumes by `cloudJobId`; Activity shows every job with stages Queued → Starting → Running → Done / Failed /
  Cancelled / Paused in an In progress section and estimated/so-far/settled cost; no metadata
  (GPS/EXIF) leaves the instance in clips or stills. Validation: service spec with a fake gateway, activity mapping
  spec, ui confirm-dialog spec, chunk fan-out and resume spec, interpolation preview/new-version spec, ffmpeg metadata
  test. Deps: CLD-201, FC MLC-103.
- **CLD-203 Cloud description batches**. Anchors: `server/src/services/cloud-ml-batch.service.ts` (new),
  `server/src/services/enrichment-plan.service.ts`, `server/src/services/image-enrichment.service.ts`, Library Care
  wording. AC: description stage routed to Frameleaf Cloud submits per-owner batches (one run per batch, never per
  asset) with `packKey`; `autoBatch` off by default with a daily USD budget; budget exhaustion stops new batches and
  notifies admins once; prompt excludes names/medical unless consented; backfill shows the estimate before enqueueing,
  computed from GPU time (photos ÷ measured throughput × class rate + start fee, p50–p90) with a per-photo estimate;
  the model comes from the descriptions ladder via the slider (Qwen3.5-4B → 9B → 27B / 35B-A3B → 122B-A10B,
  Qwen2.5-VL-72B fallback); for the 72B class a minimum batch of about 200 photos is suggested (below it the start fee
  dominates and the UI recommends the 27B/35B class).
  Deps: CLD-201, FC MLC-101.

**CLD-E04 Cloud backup (self-hosted)** — Stage 4. Anchors: `server/src/services/database-backup.service.ts`,
`server/src/services/media-health-operation.service.ts` (durable-job pattern), `server/Dockerfile`.

- ★ **CLD-301 Cloud backup: bucket claim, per-bucket key modes and content-addressed runs**. Anchors:
  `server/src/repositories/cloud-backup-store.repository.ts` (new; `@aws-sdk/client-s3` with SSE-C headers on every
  call), `server/src/repositories/cloud-backup-index.repository.ts` (new), fork migration `0000000000210-CloudBackupObjects`
  (new; `cloud_backup_object`, `cloud_backup_manifest`), `server/src/services/cloud-backup.service.ts` (new),
  `server/src/controllers/cloud-backup-admin.controller.ts` (new), `server/src/dtos/cloud-backup.dto.ts` (new),
  `server/src/dtos/config.dto.ts` (`frameleafCloud.cloudBackup` with `keyMode`; credentials `cloud-backup-bucket-key`,
  `cloud-backup-s3-secret-key`), `server/src/services/database-backup.service.ts` (`createDatabaseBackup()` returns the
  path), `web/src/lib/components/frameleaf/cloud/{CloudBackupSection,CloudBackupSetupDialog,RecoveryKitPanel}.svelte` (new).
  AC: **one bucket per server** — setup claims an empty bucket with a `frameleaf-backup.json` root marker holding the
  instance id and refuses a bucket claimed by another instance or holding foreign objects; SSE-C capability probe at
  setup; **per-bucket key**: setup first asks "Generate a key for me" (mode `server`) or "I'll maintain my own key"
  (key created in the browser; download required before continuing; "Keep a copy on this server" on = `own-stored`,
  off = `own-memory` after a typed acknowledgement); mode `server` generates a 256-bit key, stores it in the 0600 key file and shows a recovery
  kit once; mode `own-stored` accepts a user-generated key file and stores it in the key file, never escrowed; mode
  `own-memory` never persists it (`POST admin/cloud/backup/key/unlock` after each restart, backups pause until
  unlocked, status shows `keyLoaded`); every PUT/GET/HEAD carries the SSE-C headers and a request without them is a
  test failure; a run is `media_operation` kind `cloud_backup`: DB dump first (`db/`), then assets by SHA-256
  (`immich_fork.asset_checksum`, on-the-fly hashing for sidecars/profile), uploading only hashes absent from
  `cloud_backup_object` (first run reconciles against the bucket listing) as `o/<sha256>`, then a manifest
  `m/<ISO>.json.gz`; **a second run with no changes uploads nothing; two identical files on the same server produce one
  object**; `thumbs/ encoded-video/` excluded unless toggled; lease/cursor/pause/resume/cancel; restart resumes the same
  manifest; failures notify all admins. Validation: store spec against a fake S3 (asserts SSE-C headers, multipart,
  ETag/MD5), index spec, dedup spec (duplicate assets, changed file → new hash, unchanged → skipped), medium spec +
  catalog/ledger counts, ui spec. Risks: a lost own-memory key means unrecoverable backups — the UI says so before
  choosing it. Deps: CLD-002, CLD-003.
  **As built (FL-160, 2026-09-26; not yet qualified):** your own bucket (`byo-s3`) end to end; Frameleaf-managed storage
  is refused with "not available yet" (`managedAvailable: false`) because the backup grant contract (FC-33,
  Frameleaf/frameleaf-cloud#16) is not on the cloud's `main` and publishes no fixtures. The S3 client is AWS Signature
  Version 4 over Node `fetch`/`crypto` (`cloud-backup-store.repository.ts`, verified against the published S3 signing
  example) instead of `@aws-sdk/client-s3`/`lib-storage`: no lockfile change, no extra binaries, path-style addressing;
  SSE-C headers on every PUT/GET/HEAD/UploadPart/Create/CompleteMultipartUpload, `Content-MD5` and a signed SHA-256 on
  every body, 8 MiB parts, the file hashed while it uploads and the multipart upload aborted unless it matches its
  `o/<sha256>` name (SSE-C ETags are not plaintext MD5s, so ETags are required and recorded, not compared). Migration
  `2100000000670-AddCloudBackupTables` (public schema, registered in `ORDER`, the migration manifest and
  `fork-v2-catalog.json`) adds `cloud_backup_object` (PK bucket address + sha256), `cloud_backup_manifest` and
  `cloud_backup_manifest_entry` (a running manifest's files, deleted once the manifest is in the bucket). The bucket key
  is never configuration: a 0600 `cloud-backup-<fingerprint>.key` file under the identity directory (server, own-stored;
  written with an exclusive link, never overwritten) or memory only (own-memory, handed between workers over the
  server event bus, `CloudBackupKeyShare`/`CloudBackupKeyRequest`); only the bucket's secret access key is a write-only
  configuration credential (`ConfigCredential.CloudBackupS3SecretKey`). Fingerprints are the prototype's FNV-1a
  `XXXX-XXXX`; the recovery kit carries the key as a Crockford base32 `FLRK-…` code. API `admin/cloud/backup` (status,
  `check`, `key`, `setup`, `key/unlock`, `DELETE` to turn off, `runs`, `runs/:id/pause|resume|cancel`) with
  `adminCloudBackup.read|update|run`; `MediaOperationKind.CloudBackup` is pausable and resumable and retried once, a run
  with no own-memory key waits (requeued every minute, admins told once a day) instead of failing, a final failure
  notifies admins once a day. Runs read internal assets only (`isExternal = false`, active and trashed, Locked
  included). Not in this slice: schedule, retention, verification, escrow, restore and the Activity progress stages
  (CLD-302), and the managed grant and key rotation (FC-33).
- ★ **CLD-302 Cloud backup: schedule, retention, verification, managed storage, escrow and restore**.
  Anchors: `cloud-backup.service.ts`, `server/src/commands/cloud-backup.command.ts` (new),
  `web/src/lib/components/frameleaf/cloud/CloudBackupRestoreDialog.svelte` (new). AC: cron under
  `DatabaseLock.FrameleafCloudBackup` (single scheduler); retention keeps daily/weekly/monthly manifests and deletes
  only objects referenced by no kept manifest; weekly verify = sampled GET + sha256 of 1/52 of objects, monthly HEAD of
  every referenced hash, mismatches notify admins; managed grant fetched at run start (`POST /v1/backup/grant`,
  bucket-scoped credentials never persisted); usage/quota from the cloud, over-quota ⇒ read-only and uploads stop
  without touching data; scrypt-wrapped escrow `PUT/DELETE` offered in `server` key mode only; restore by manifest
  (files → `<media>/frameleaf/restore/<id>` for Library Care; single asset restore; database → existing maintenance
  restore), every downloaded object sha256-verified; `immich-admin cloud-backup restore --bucket … --key-file …`
  documented for bare-metal recovery; each run and restore appears in Activity with its stage and progress (Queued →
  Starting → Running → Done / Failed / Cancelled / Paused) and under Settings → Background work. Deps: CLD-301, FC BAK-001, FC BAK-002.

### 11.5 Confluence pages

**FR (fork)** — under "Frameleaf Implementation Plan" (61538319), source-owned mirrors with source path +
SHA-256 + backlink (labelled "uncommitted candidate" until the CLD-000 PR merges):

1. "Frameleaf Cloud program plan" ← `docs/superpowers/specs/2026-09-24-frameleaf-cloud-design.md` (sections 1–4, 8–10 of this plan, customer-safe wording).
2. "Frameleaf Cloud: self-hosted integration" ← `docs/docs/developer/frameleaf-plan/15-frameleaf-cloud-integration.md` (Workstream A: contracts the instance implements, module map, config/env, API, edge worker, slices).
3. "Delivery Sequence and Jira Backlog" (61407624) gets a paragraph + link for workstream `cloud`; "Complete Feature Ownership and Jira Coverage" (61538800) a row per CLD story.

**FC (cloud)** — rewrite the home page (63733939) and add child pages (initial authoring from this plan; the
frameleaf-cloud repo `docs/` becomes the source of truth in OPS-001 and mirrors back with hashes):

1. "Frameleaf Cloud Home": what it is, decisions table (§2), naming rule, links to Jira FC board and the pages below.
2. "Architecture and trust boundaries" (§3).
3. "Instance contract: discovery, linking, tokens, heartbeat, certificates" (§4 minus ML/relay detail).
4. "Identity provider" (IDN design: Better Auth + oidc-provider config, claims, prompts, invariants, exit path).
5. "Entitlements, Stripe and licensing" (ENT design, key format, certificate claims, webhook table).
6. "AI Wallet" (ledger kinds, hold rules, top-ups, statements, limits).
7. "Remote access: control plane, DNS and relay" (REM design: domain/PSL/LE, PowerDNS, tokens, handshake, h2 tunnel, caps, metering, failure modes, costs).
8. "Cloud backup service" (BAK design, Wasabi facts, policies, escrow, purge).
9. "Frameleaf Cloud ML" (Workstream C: scope matrix, architecture, substrates, worker protocol, storage, v2 API, catalog + rights, pricing, privacy, milestones).
10. "Delivery sequence and Jira backlog (FC)" (§11.4 with Jira keys once created; dependency graph).
11. "Operations, security and compliance" (OPS: hosting, CI/provenance, backups, observability, GDPR/DPIA, subprocessors, costs).

### 11.6 Execution procedure (after approval)

1. Fork PR `codex/FL-<CLD-000>-frameleaf-cloud-workstream`: write the spec + workstream guide, add the CLD
   backlog records, update the validator counts/evidence/jira-map (keys filled after step 3), mirror FR pages
   (read back, record in `confluence-mirror.json`). No feature code.
2. Create the FC Confluence pages (home rewrite + 10 children) with a "source: frameleaf-cloud repo docs (OPS-001);
   initial authoring 2026-09-25" header; read each page back.
3. Create epics: FL `CLD-E01..E04`; FC `OPS-E01, IDN-E01, INS-E01, ENT-E01, WAL-E01, REM-E01, REM-E02, BAK-E01,
MLC-E01, MLC-E02, WEB-E01`. Record keys.
4. Create stories/tasks from the template with `parent` + `labels`; verify each by reading it back; record keys in
   `jira-map.json` (FL) and in the FC backlog page.
5. Create `Blocks` links (transitively reduced) and `Relates` links to FL-10/FL-67/FL-80/FL-131/FL-42/FL-110/FL-114.
6. Comment on FL-146 (decisions now answered: supporter page destination `/buy` + deployment-configured store URL,
   key format, purchase wording replaced, version checks stay off, cloud opt-in, the GPU provider replaced by Frameleaf Cloud)
   and on FL-42/FL-110/FL-114/FL-128 (wording superseded by CLD-201; owner to approve description edits).
7. Verify with JQL counts (`project = FL AND labels = frameleaf-cloud`, same for FC) and report every created key.
   Never transition issues beyond To Do here; never push to `origin`; the fork PR targets `master/frameleaf-implementation`.

---
