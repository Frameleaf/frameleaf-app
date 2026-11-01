# Identify photo locations

Frameleaf can suggest the business or venue near a photo's GPS coordinates. This optional feature is included in a paid Frameleaf Cloud plan covering the person and server. It does not charge AI credit.

## Run a scan

Open **Settings → Library care → Identify photo locations**. Read the disclosure, grant permission for that scan, and choose **Identify photo locations**. Frameleaf sends coordinates and reported GPS accuracy to Frameleaf Cloud; Google receives location searches when Cloud does not already know an area. Photo files, filenames, photo identifiers and capture times are not uploaded.

Every scan requires an explicit action. The first scans eligible photos in your library; later scans cover new or changed locations and previous failures. **Refresh existing results** deliberately searches again, including refreshing Cloud's cached place data. Scans never start automatically when you upload a photo.

Archived photos are included. Trashed, hidden, Locked, sensitive and other people's shared photos are excluded. Photos without valid coordinates and the video parts of Live Photos are excluded too.

Progress and a cancellation action stay available while a scan is running. Cloud limits or a temporary provider failure can pause a scan; retryable pauses resume the same requested scan when the allowance becomes available. If a pause requires attention, cancel it and start another scan after resolving its cause.

## Read a suggestion

Photo info shows **Suggested location**, separately from the recorded coordinates and existing landmarks. Strong, unambiguous matches can say **Taken at**; less precise matches say **Near**. Both are marked **Inferred**, with the supplied place name, an address where available, Google Maps attribution and a Google Maps link. Uncertain results have no suggestion.

Reported GPS accuracy is required for the stronger wording. Coordinates alone cannot prove which shop you visited, especially in malls or buildings with several businesses. Suggestions use current mapped listings and do not establish that a business existed when an older photo was taken. Cached listings can become outdated.

The owner can dismiss a suggestion without changing the photo's GPS or EXIF. A dismissal survives scans, refreshes and unrelated metadata edits until the coordinates change. Changing or removing coordinates invalidates both a saved suggestion and results still being processed. Suggestions do not create Places, landmarks, albums or search tags.

## Privacy and availability

Cloud checks its own place listings and searched-area coverage first. Known matched, empty and ambiguous areas avoid Google requests during normal scans; unknown areas are grouped to reduce requests. Shared cache records contain provider place information, without photo or account associations.

Private Cloud inputs and results are deleted on acknowledgement or cancellation, otherwise within 24 hours of completion or failure. Unfinished Cloud scans expire after seven days. Local temporary input is also cleaned up, including input left behind by a deleted account. Suggestions stored on your server remain readable after a plan expires. Sharing permissions that hide photo location also hide the suggestion.

This feature is disabled by default during qualification. Server administrators opt in through `FRAMELEAF_PHOTO_LOCATIONS_ENABLED=true`; Frameleaf Cloud must also enable the service. No Google key belongs on a self-hosted server or in the browser. A scan supports one compressed JSON file up to 128 MiB compressed and 1 GiB expanded; larger inputs are refused without silently omitting photos.
