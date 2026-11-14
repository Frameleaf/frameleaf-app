# Disposable native qualification

Run this from the repository root on Linux or macOS:

```sh
python3 integrations/wordpress/tests/run.py --wordpress 7.1.4
```

Prerequisites: Python 3.12+, Node.js 20+, OpenSSL, Docker, and PHP with `curl`, `dom`, `gd`, `mbstring`, `mysqli` and `openssl`. PHP's built-in multi-worker server must be available. The runner downloads official WordPress and WP-CLI, verifies pinned SHA-256 values, and additionally verifies WordPress core against WordPress.org's checksums before executing it. It starts a bounded disposable MariaDB container, six PHP workers and a synthetic OAuth/Connect provider. No existing WordPress site or database is used.

Every installation, password, salt, certificate, image, database credential, log and built ZIP is generated under a private temporary directory outside the checkout. Generated media are two 120×80 color rectangles. The task-only CA is trusted explicitly by the fixture clients; system trust and TLS verification are never changed. All HTTP servers bind to loopback with temporary ports. The runner independently attempts to stop its process groups, drop only its uniquely named database and remove its own container when finished. Cleanup failures fail the run; if qualification also failed, that original error is preserved with cleanup failures attached. Use `--keep` to preserve the private files/logs after that cleanup; never commit or publish them.

The default Docker image is the pinned official MariaDB 11.8 digest. CI supplies an isolated MariaDB service instead: `FRAMELEAF_TEST_DB_HOST=127.0.0.1:PORT` and `FRAMELEAF_TEST_DB_PASSWORD` select it. Only loopback endpoints are accepted. The service must be disposable and grant database creation; the runner creates a random `frameleaf_i04_*` database and never selects an existing database. Do not supply a shared or production database. No external hostname is accepted for this mode.

The GitHub workflow runs WordPress 6.8 / PHP 8.1 and WordPress 7.1.4 / PHP 8.5 as separate exact-candidate jobs. Use `--wordpress 6.8` with PHP 8.1 to reproduce the declared-minimum job. A matrix entry is a required check, not evidence that an unrun version passed. WP-CLI 2.12.0 may emit its own PHP 8.5 deprecation messages; the runner retains those in private logs separately from plugin/test results.

The single command exercises:

- Credential encryption, PKCE, native WordPress database compare-and-swap and key rotation.
- Actual HTTPS authorization/callback using separate WordPress sessions; wrong, replayed and cross-user callback rejection; missing REST nonce and anonymous denial.
- Twelve simultaneous refresh requests: exactly one rotation and no reused refresh tokens. Uncertain rotation is quarantined; failed disconnect retains credentials for revocation retry.
- Twelve concurrent imports: one permanent attachment. Real native sideloads cover identical-byte reuse, changed bytes with identical timestamps, deleted local attachments, subscriber denial, read-only destination failure and temporary-file/claim cleanup.
- Untrusted certificates, administrator origin/private-network restrictions, and fourteen controlled DNS/transport assertions without contacting external or private services. Missing cURL pinning support fails closed.
- Packaging and WordPress-native MO lookup for all eleven languages.

The workflow also runs `bootstrap-test.py`: controlled mocks verify that a child cleanup failure and database timeout cannot skip later cleanup, hide the original test error or suppress a cleanup-only failure. These checks do not create a fixture or contact a service.

`provider.mjs`, `mu-fixture.php` and `install.php` are test-only sources. They never enter the installable plugin ZIP. The provider is synthetic and does not establish live Frameleaf Library direct/customer HTTPS/relay acceptance. Browser qualification, Classic/Gutenberg interaction, Plugin Check and directory review remain separate checks.

For a retained fixture, install the official WordPress Plugin Check and run `wp plugin check frameleaf-connect --format=json`. The bundled `load_plugin_textdomain` warning is intentional for direct ZIP installations. Keep screenshots and review reports outside the repository; do not bypass browser TLS warnings. The previously qualified Gutenberg screenshots used a separate synthetic UI-only HTTP proxy, while OAuth/refresh qualification used strict HTTPS.

Artifact pins were obtained from the official versioned WordPress archives and WP-CLI v2.12.0 release; WP-CLI's SHA-256 was also matched to the official release checksum. Update pins deliberately when changing qualified versions. The PHP setup action and MariaDB image are pinned in the workflow. No credentials, marketplace publication or real media uploads are part of these tests.
