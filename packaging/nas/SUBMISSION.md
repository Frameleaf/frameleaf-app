# Frameleaf NAS release and submission

Frameleaf application releases start at **1.0.0**, independently of Immich.
Manager is a separate component (`manager-v0.1.2`); the native Synology shell
has its own version in the private `Frameleaf/frameleaf-synology` repository.
Unraid and TrueNAS installers consume authenticated Manager image digests.
Native Synology source and SPKs must stay in the private repository.

## Prepare an application release

1. Set the application version with `node scripts/frameleaf-version.cjs 1.0.0`.
   For later releases, use patch/minor/major SemVer for fixes/features/breaking
   changes, or a named prerelease such as `1.1.0-rc.1`. Review and merge the
   resulting source change. CI runs `node scripts/frameleaf-version.cjs --check`.
   This synchronizes server, web, CLI, SDK, test package, API metadata and Python
   project/lock versions. Manager, NAS wrapper revisions, dependencies and Immich
   import-source compatibility versions remain independent.
2. Let **Deploy** qualify the exact `main` commit on amd64 and arm64. The database
   and CLI image workflows must also succeed and their packages must be public.
3. Run **Deploy production** on `main`, action `release`, candidate set to that
   exact commit, with dry-run enabled. After a successful rehearsal, repeat for
   the same still-current commit with dry-run disabled. The protected production
   environment owns signing and publication.
4. Verify the published `frameleaf-v1.0.0` release, complete installation assets,
   signed image digests and successful promotion run. Every later production
   release needs a version bump; publishing changed bytes under the same version
   is refused. A failed partial promotion may resume only at the same source SHA.

The retired `frameleaf-v3.2.0-N` rebuild tags remain usable for explicit,
version-matched recovery. They are excluded from the new server's update offers.
A feed response must name the matching independent tag; an old cloud feed falls
back to GitHub. Existing 3.2 servers cannot recognize 1.0.0 as a newer SemVer:
first update Manager to **0.1.2 or later**, then explicitly review and select
the 1.0.0 application release for this one-time transition. Older Manager
versions require numbered rebuild tags and cannot select the new release format. Keep a matched database/media/configuration/key backup. Restoring a
legacy backup requires its matching legacy release; changing image tags against
an upgraded database is not rollback. An Immich import is a separate offline
operation and its source version is not changed by Frameleaf's release number.

## Build the NAS deliverables

1. Bump `manager/package.json`, the root and application entries in
   `manager/package-lock.json`, and the default tag in `.github/workflows/manager.yml`
   together whenever publishing changed Manager code. Run **Frameleaf Manager**
   on `main`, with `publish=true` and its matching new component tag. Both
   architectures and the production publication job must pass.
2. Run **NAS packages** on `main`. Supply that published Manager tag. Optionally
   supply `frameleaf-v1.0.0` to build the separate manual Server/ML templates and
   TrueNAS direct-stack catalog source from its signed release.
3. Download the `frameleaf-nas-packages` workflow artifact. Check its SHA256SUMS.
   The build has verified signatures, attestations, source runs and immutable
   image references. The checksum file protects transport; it does not replace
   those authenticity checks. Retain the workflow URL, source SHA and manifests.

The artifact contains `manager/unraid/` and
`manager/truenas/frameleaf-manager.compose.yaml`. If requested, `application/`
contains manual Unraid templates and `truenas/ix-dev/community/frameleaf` catalog
source. Manager's TrueNAS installer is a Custom App, not a catalog listing.

## Unraid Community Applications

1. Copy `manager/unraid/` into the public
   [Frameleaf/unraid-apps](https://github.com/Frameleaf/unraid-apps) repository.
   Preserve independently qualified manual templates. To publish those too, merge
   `application/unraid/` first and Manager's directory second. Retain both manifests,
   the signing public key and a fresh checksum file with the catalog source SHA.
2. Check the published raw TemplateURL, icon, support and WebUI links. The public
   repository needs its root OSI license, `ca_profile.xml` and rendered XML files.
   Publish `.xml`, never the `.xml.in` source templates.
3. Sign in to [Community Apps Submit](https://ca.unraid.net/submit), supply the
   public repository URL, and run **Validate** and **Scan** after XML changes.
   Resolve reported errors and submit for review. Record the submission receipt
   and final listing URL separately.

Use the [current submission guide](https://ca.unraid.net/submit/help) and
[XML contract](https://ca.unraid.net/submit/help/repository-xml). Before installing,
configure the exact HTTPS origin and dedicated persistent folders as described
in the generated Unraid README. Manager needs the Docker socket and its declared
mounts to manage sibling services; review those permissions in the listing.

## TrueNAS

For immediate installation, use Apps → Custom App → **Install via YAML**, with
the generated Manager Compose file. Set the exact HTTPS origin and create the
dedicated datasets first. Replace all example host paths and keep each host path
identical to its container path. Map only approved storage roots.

For a catalog submission, use the generated direct-stack app source and the
[TrueNAS apps contribution guide](https://github.com/truenas/apps/blob/master/CONTRIBUTIONS.md).
The current catalog target is `truenas/apps`, branch `master`, under
`ix-dev/community/frameleaf`. Check for existing issues/PRs, then open a draft
catalog PR with the generated app files, installation notes and image evidence.
Use the catalog's required TrueNAS maintainer metadata. Attach the Frameleaf icon
and screenshots so the reviewer can supply TrueNAS CDN URLs.

The current catalog library is 2.3.17; this repository deliberately pins and tests
2.3.4. Update and qualify the submission copy against the catalog's current
library before requesting catalog review. Keep this package's pinned renderer
unchanged until its replacement has passed both ML modes. In the catalog checkout:

```sh
devbox run copy-lib
./.github/scripts/port_validation.py
./.github/scripts/ci.py --app frameleaf --train community --test-file basic-values.yaml --render-only=true
./.github/scripts/ci.py --app frameleaf --train community --test-file basic-values.yaml
```

Use disposable storage for the deployment test. Record the external PR and
accepted listing URL separately. The Manager Custom App can be installed without
a catalog submission.

## Synology Package Center

Build and release only in the private
[Frameleaf/frameleaf-synology](https://github.com/Frameleaf/frameleaf-synology)
repository. Its `dsm/README.md` documents the official DSM toolkit build; its
packaging command requires native UI output from the exact private source commit
and an authenticated Manager manifest. Use its private release/submission guide.
Do not upload SDK fixtures or public-app artifacts as a production SPK.

Apply through [Synology's developer portal](https://www.synology.com/en-global/support/developer#apply).
Prepare the SPK, checksum, supported DSM/Container Manager versions, product and
support details, license/privacy information, icons, screenshots and installation
instructions. Follow the material requests in the portal and retain the package
ID, submission receipt and final listing URL. Synology's
[approval guide](https://help.synology.com/developer-guide/publish_package/summit_package_for_approval.html)
requires an internally tested package before submission.

For every platform, test fresh install, restart, upgrade, failed-upgrade recovery,
data-retaining uninstall and matched backup restore on a disposable NAS library.
Record actual platform versions and outcomes. A passing package build establishes
neither physical NAS behavior nor store approval.
