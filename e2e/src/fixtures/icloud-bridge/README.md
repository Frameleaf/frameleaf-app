# TEST-ONLY iCloud bridge material (FL-144)

Everything here is for the e2e fake bridge (`../icloud-bridge-fixture.mjs`,
`e2e/docker-compose.icloud-bridge-fixture.yml`) and nothing else. None of it is a secret: never
use it outside e2e, never mount it into a real deployment.

- `test-only-ca.crt` — a throwaway CA (its private key was discarded after signing).
- `test-only-bridge.crt` / `test-only-bridge.key` — the fake bridge's TLS certificate for
  `DNS:icloud-bridge-fixture`, signed by that CA.
- `test-only-bridge-token` — the bearer token the server presents to the fake.
- `test-only-encryption-key` — the base64 32-byte key the server encrypts stored sessions with.

Production generates its own per installation: see `docs/docs/guides/icloud-photos-server-setup.md`.
