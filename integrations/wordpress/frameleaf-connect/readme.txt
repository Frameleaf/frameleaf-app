=== Frameleaf Connect ===
Contributors: frameleaf
Tags: images, media-library, photography, oauth
Requires at least: 6.8
Tested up to: 7.1
Requires PHP: 8.1
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Import images from selected Frameleaf albums into the WordPress Media Library.

== Description ==
Choose Frameleaf in the native media selector, browse your authorized albums, and import processed JPEG, PNG or WebP images. The imported copy becomes an ordinary WordPress attachment with editable caption and alternative text. Gutenberg uses the same media selector.

Every editor connects their own Frameleaf account. Only users with WordPress's upload_files capability can browse or import. Administrators approve Library origins before any connection. The plugin uses OAuth with PKCE, selected-album consent and server-side encrypted tokens; no access-token pasting is needed.

Imported attachments follow your WordPress site's normal media visibility. They remain in WordPress after disconnecting or revoking Frameleaf access. There is no background synchronization, deletion or upload back to Frameleaf.

== Installation ==
1. Install the ZIP through Plugins, Add Plugin, Upload Plugin, then activate it.
2. As an administrator, open Media, Frameleaf. Add the Library's HTTPS origin. Allow private networking only for a Library you administer.
3. If your Library disables automatic registration, create a Connect client using the exact callback shown on this page and save its non-secret client ID.
4. Each editor opens Media, Frameleaf, chooses a Library, selects Connect Frameleaf, and approves only the albums needed.
5. While editing a post, open the media selector and choose Frameleaf. Select an album or search, acknowledge the local copy, and import an image. Edit caption and alt text using WordPress's attachment controls.

Frameleaf requires PHP cURL with HTTPS support and a direct network route to the Library. HTTP proxies are not used for Library requests.

WordPress requires a trusted HTTPS callback. The WordPress server must trust and reach the configured Library HTTPS origin. Local or customer-provided HTTPS access does not require Frameleaf Cloud; use of Frameleaf relay requires its existing plan. A WordPress installation that permits plugins is required.

== External services ==
This plugin contacts only the Frameleaf Library origins explicitly approved by the WordPress administrator. During connection it sends the client ID, PKCE challenge/code exchange and requested library:read scope. During use it sends authenticated album/search/media requests to that Library and copies the image bytes the editor selects into WordPress. Refresh and revocation requests remain server-side. No telemetry or media is sent to a separate plugin service.

Your Library administrator controls its service and privacy terms. Frameleaf product information and policies: https://frameleaf.app/ . Review your Library's privacy policy before connecting it. No Frameleaf account or subscription is created by installing this plugin.

== Frequently Asked Questions ==

= What happens after disconnecting? =
The plugin revokes its Library grant. Already imported attachments remain in WordPress. If revocation cannot reach the Library, the plugin retains encrypted credentials for another disconnect attempt and stops imports.

= What happens if WordPress keys or salts change? =
Reconnect after revoking WordPress access in Frameleaf. Confirm that revocation on Media, Frameleaf, then use Reset after a WordPress key change. Reset is available only when the stored credentials can no longer be decrypted; it cannot bypass normal grant revocation.

= Why can a repeated import download the image again? =
The plugin compares a SHA-256 digest of the current rendition. Identical bytes reuse the same attachment; a changed rendition creates a new copy even when metadata timestamps stay the same. Existing copies are never overwritten.

= Which limits apply? =
Imports are bounded by the smaller of WordPress's upload limit and 16 MiB, and by 40 million decoded pixels. Previews are limited to 2 MiB. Only processed JPEG, PNG and WebP renditions are imported. Originals and private sharing links are not requested. WordPress may generate its normal attachment sizes.

= How are failed or interrupted imports handled? =
Ordinary sideload errors remove unpublished temporary data. An interrupted publication with an uncertain database receipt remains blocked from automatic retry to avoid duplicate copies. An administrator should inspect the attachment and pending frameleaf_imports receipt before recovery; do not blindly delete pending receipts. Disconnecting never removes completed attachments.

== Screenshots ==
1. Frameleaf album browsing within the native WordPress media selector.
2. An imported attachment with native caption and alternative-text controls.

== Changelog ==

= 0.1.0 =
* Initial selected-album connection and image import.
