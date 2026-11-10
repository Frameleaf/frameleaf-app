# Frameleaf NAS release and submission

Frameleaf application releases start at **1.0.0**, independently of Immich.
Manager is a separate component (`manager-v0.2.3`); the native Synology shell
has its own version in the private `Frameleaf/frameleaf-synology` repository.
Unraid and TrueNAS installers reference `:latest` images and never pin a release.
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

The retired `frameleaf-v3.2.0-N` releases and their registry images were removed
for the independent release reset. Recovery of a legacy installation requires
previously retained, authenticated, version-matched images and installation files;
the old Git tags alone cannot restore deleted release assets or registry images.
Legacy rebuild tags are excluded from the new server's update offers.
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

The artifact contains `manager/unraid/`,
`manager/truenas/frameleaf-manager.compose.yaml` and `manager/hexos/`. If requested, `application/`
contains manual Unraid templates and `truenas/ix-dev/community/frameleaf` catalog
source. Manager's TrueNAS installer is a Custom App, not a catalog listing.

## Unraid Community Applications

1. The public [Frameleaf/unraid-apps](https://github.com/Frameleaf/unraid-apps)
   repository publishes the listing itself: its **Publish catalog** workflow
   checks every six hours for a newer signed Manager release or stable Frameleaf
   release, rebuilds the repository-root catalog files (`templates/`, `README.md`,
   `ca_profile.xml`, `manager-manifest.json`, `nas-manifest.json`,
   `catalog-source.json` and `SHA256SUMS`) and commits them. The Manager template
   and listing copy come from the Manager release's commit; the manual Server and
   ML templates come from `build.cjs` at the Frameleaf release's commit. Run it by
   hand to publish at once. Listing copy and the Manager template on `main` reach
   Community Apps with the next Manager release; Server and ML template changes
   reach it with the next Frameleaf release. An application release alone keeps
   the listing copy from the unchanged Manager release. Screenshots in `images/`
   are updated by hand.
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
`ix-dev/community/frameleaf`. Check for existing issues/PRs, then open a
catalog PR with the generated app files, installation notes and image evidence.
Use the catalog's required TrueNAS maintainer metadata. Attach the Frameleaf icon
and screenshots so the reviewer can supply TrueNAS CDN URLs.

This package pins and tests catalog library **2.3.18**, the latest version at
TrueNAS apps commit `99df68c9497e3966d33ee4e0990df7009e3f49a9`. Before submission,
check for a newer catalog library and qualify any replacement in both ML modes.
In the catalog checkout, generate the matching library and run its checks.
The icon and screenshots use public Frameleaf source assets. Attach the icon
and the three screenshots listed in `app.yaml` to the submission. The reviewer
must provide TrueNAS CDN URLs; replace both `app.yaml` and `item.yaml` media
URLs before metadata validation can pass. Run the
metadata generator to refresh catalog fields; with the required floating
`:latest` images, it sets `app_version` to `latest`. Keep the signed release
manifest as evidence of the application version used for qualification.

```sh
python3 .github/scripts/prepare_libs.py --train community --app frameleaf
python3 .github/scripts/generate_metadata.py --train community --app frameleaf
./.github/scripts/port_validation.py
./.github/scripts/ci.py --app frameleaf --train community --test-file basic-values.yaml --render-only=true
./.github/scripts/ci.py --app frameleaf --train community --test-file basic-values.yaml
```

Use disposable storage for the deployment test. Record the external PR and
accepted listing URL separately. The Manager Custom App can be installed without
a catalog submission.

## HexOS

HexOS runs TrueNAS underneath and installs apps from JSON install scripts. Manager
is a `custom: true` script on TrueNAS's generic `ix-app` chart; it asks HexOS for the
ApplicationsPerformance, ApplicationsCapacity and Photos locations and mounts each
Frameleaf folder at its host path. The `ix-app` chart keeps Docker's default
capabilities and turns off `no-new-privileges`, so Manager's entrypoint drops its
bounding set to CHOWN, DAC_OVERRIDE and FOWNER and sets `no-new-privs` itself.

- **Custom Install:** every Manager release attaches the signed installer as
  `frameleaf-manager.hexos.json`, image `:latest`; the NAS packages artifact carries
  the same file at `manager/hexos/frameleaf-manager.hexos.json`. In HexOS, turn on
  Dev Mode in Preferences, choose **Custom Install** in Apps and paste it.
- **App catalog:** `manager/hexos/frameleaf.json` is the same script with only the
  image tag set to that Manager release (`manager-vX.Y.Z`). The catalog validator
  refuses `latest` on a public app; the owner approved this one pinned copy
  (FL-1111). Copy it into a fork of
  [eshtek/hexos-app-catalog](https://github.com/eshtek/hexos-app-catalog) as
  `frameleaf.json`, run `bun _lib/validate.ts` there and open a pull request that
  explains the Docker socket and `/proc/1/mountinfo` mounts. After it is accepted,
  the catalog's image watcher opens its own pull requests for later `manager-v`
  tags; submit again only when the script itself changes.

Not yet qualified on a HexOS box: `$LOCATION` inside `mount_path`, the `root` owner
on the Frameleaf folders, Custom Install accepting `latest`, and importing an Immich
that HexOS installed. HexOS can restart its own Immich app, which Manager's
restart-policy fence does not prevent; stop Immich in HexOS before an import.

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
