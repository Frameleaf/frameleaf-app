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

## Synthetic test-only material (for secret scanners and reviewers)

The private key, bearer token and encryption key in this directory are **synthetic, test-only
fixtures**, generated solely for the e2e fake bridge and committed on purpose:

- they were never used by, and are not accepted by, any real Apple, Frameleaf or customer system;
- the certificate chain is self-signed by a throwaway CA whose key was discarded, so it cannot be
  reused for anything but the `icloud-bridge-fixture` container on the e2e network;
- the token and encryption key protect nothing but fixture data that the e2e run creates and drops;
- nothing outside `e2e/` references them (`e2e/docker-compose.icloud-bridge-fixture.yml` mounts them).

A secret scanner match on this directory is a known false positive. Repository hygiene is enforced
by `.github/check-repository-hygiene.sh` (ignore-rule based; there is no path allow-list file to
extend). If a dedicated secret-scanner allow-list is added later, list this directory in it and
point at this section. Do not copy these files anywhere else; rotating them means regenerating all
three together and updating the e2e fixture.
