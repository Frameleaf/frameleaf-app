# Identify photo locations

Frameleaf can suggest the business or venue near a photo's GPS coordinates. This optional Cloud AI job costs **$5 per 1,000 checked photos**, paid from AI credit. A live Frameleaf licence covering the person and linked server is required. A Cloud subscription does not include this usage for free.

## Run a scan

Open **Settings → Library care → Identify photo locations**. Choose a spending or photo limit, then request an estimate. The default spending limit is $5; the alternative photo limit starts at 1,000. Review the eligible, selected and remaining photos, maximum credit reservation and available balance. Read the disclosure, grant permission for that job, then confirm the reservation. Estimates expire after 15 minutes and can authorize one job.

Frameleaf sends coordinates and reported GPS accuracy to Frameleaf Cloud; Google receives location searches when Cloud does not already know an area. Photo files, filenames, photo identifiers and capture times are not uploaded. Estimating only counts eligible photos and does not upload coordinates.

Every scan requires an explicit action. The first selects eligible photos in your library within the approved limit; later scans cover remaining, new or changed locations and previous failures. **Refresh existing suggestions** deliberately searches again, including refreshing Cloud's cached place data, at the same checked-photo rate. Scans never start automatically when you upload a photo.

Archived photos are included. Trashed, hidden, Locked, sensitive and other people's shared photos are excluded. Photos without valid coordinates and the video parts of Live Photos are excluded too.

Progress and a cancellation action stay available while a scan is running. Cloud limits or a temporary provider failure can pause a scan; retryable pauses resume the same requested scan when the allowance becomes available. If a pause requires attention, cancel it and start another scan after resolving its cause.

## Credit reservation and final charge

Starting reserves credit for the selected maximum through an AI credit **HOLD**. Each photo with a completed match or no reliable match costs exactly $0.005, including cached and duplicate-coordinate photos. There is no minimum block of 1,000 photos. Invalid input, retries and photos left unchecked do not add charges.

When the job ends, **SETTLE** charges only checked photos and releases the unused reservation. Cancellation and failure retain charges for work already checked. Completed suggestions are kept after current ownership, GPS and privacy are checked again. A 1,000-photo job reserves $5; cancellation after 275 checked photos charges $1.375 and releases $3.625. The final receipt shows checked photos, the charge and released credit. If settlement is still pending, Frameleaf keeps checking for its final receipt. Existing AI spending permissions, wallet safeguards and monthly limits also apply.

## Read a suggestion

Photo info shows **Suggested location**, separately from the recorded coordinates and existing landmarks. Strong, unambiguous matches can say **Taken at**; less precise matches say **Near**. Both are marked **Inferred**, with the supplied place name, an address where available, Google Maps attribution and a Google Maps link. Uncertain results have no suggestion.

Reported GPS accuracy is required for the stronger wording. Coordinates alone cannot prove which shop you visited, especially in malls or buildings with several businesses. Suggestions use current mapped listings and do not establish that a business existed when an older photo was taken. Cached listings can become outdated.

The owner can dismiss a suggestion without changing the photo's GPS or EXIF. A dismissal survives scans, refreshes and unrelated metadata edits until the coordinates change. Changing or removing coordinates invalidates both a saved suggestion and results still being processed. Suggestions do not create Places, landmarks, albums or search tags.

## Privacy and availability

Cloud checks its own place listings and searched-area coverage first. Known matched, empty and ambiguous areas avoid Google requests during normal scans; unknown areas are grouped to reduce requests. Shared cache records contain provider place information, without photo or account associations.

Cloud deletes the uploaded document and unfinished private location data on cancellation or failure. Completed encrypted results are deleted when acknowledged, otherwise within 24 hours of the job ending. Unfinished Cloud scans expire after seven days. Local temporary input is also cleaned up, including input left behind by a deleted account. Minimal billing receipts retain counts and ledger proof separately from GPS data. Suggestions stored on your server remain readable after a licence expires. Sharing permissions that hide photo location also hide the suggestion.

Photo location identification has no environment feature switch. No Google key belongs on a self-hosted server or in the browser. A scan supports one compressed JSON file up to 128 MiB compressed and 1 GiB expanded; larger inputs are refused without silently omitting photos.
