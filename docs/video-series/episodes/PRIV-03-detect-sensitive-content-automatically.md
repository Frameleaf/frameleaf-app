# PRIV-03 · Detect sensitive content automatically

| Field | Value |
| --- | --- |
| Series | Private by design |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators who want possibly sensitive images found and kept private, and the owners who review the results |
| Features demonstrated | Rollout order (detect, review and tune, then hide), NSFW detection settings (Detect NSFW images, Hide detected NSFW assets, NSFW detection model, NSFW threshold), backfill with the Locked-content detection queue (Run missing), Needs sensitivity review quick filter, the Enrichment section's Sensitive content row (Needs review, likely-sensitive score, Accept, Unmark Sensitive as mark safe, Check again with AI, Overridden, Reviewed by you), Sensitivity review filter, Hide detected NSFW assets and the Detected lock reason, images only, tags are not the lock |
| Source docs | docs/docs/features/image-enrichment.md, docs/docs/features/fork-privacy-suite.md |
| Capture checklist | Signed in as Taylor (admin and owner of the sample library), dark theme. Settings → Search & intelligence with the NSFW detection group at defaults (off, threshold 0.85, hide off). The capture uses seeded review states on landscape and document photos only: Lake reflection and Glacier creek flagged "Needs review" at about 88% and 86%, one scanned document page flagged at about 90%, everything else checked and clear. Job manager under Compute & jobs. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:12 | LOWER-THIRD "Detect sensitive content automatically · Private by design"; SCREEN Locked view with the Detected filter, empty for now | Detect, then decide | "Frameleaf can check your images for sensitive content. You review what it finds before anything is hidden." |
| 3 | 0:12–0:24 | CARD headline "Roll out in this order"; numbered bullets: "1 Detect", "2 Review and tune the threshold", "3 Then hide" | Detect · Review · Hide | "Roll it out in three steps. Detect first. Review the results and tune the threshold. Only then turn on hiding." |
| 4 | 0:24–0:40 | SCREEN Settings → Search & intelligence; group "NSFW detection" ("Use a dedicated classifier to mark images that may contain explicit content"); CURSOR turns on "Detect NSFW images"; HIGHLIGHT "Hide detected NSFW assets" left off; CALLOUT on "NSFW detection model" | Detect NSFW images: on · Hide: off | "Open Settings, then Search & intelligence, and find NSFW detection. Turn on Detect NSFW images, and leave Hide detected NSFW assets off for now. The model is a dedicated classifier, not the description model." |
| 5 | 0:40–0:52 | ZOOM on "NSFW threshold" reading 0.85 with its help "Minimum score from 0-1 required to mark an image as NSFW."; CURSOR clicks "Review changes", then "Save changes" | NSFW threshold 0.85 | "NSFW threshold is the minimum score, from zero to one, that counts as a detection. It starts at zero point eight five. Review your changes and save." |
| 6 | 0:52–1:06 | SCREEN Settings → Compute & jobs → Job manager; ZOOM on the queue "Locked-content detection" ("Identify images to keep Locked."); CURSOR clicks "Run missing"; review dialog; CURSOR confirms; the queue's waiting count ticks up, then down | Locked-content detection → Run missing | "New uploads are checked automatically. For the images you already have, open Job manager under Compute & jobs, find Locked-content detection and choose Run missing." |
| 7 | 1:06–1:18 | SCREEN search palette; ZOOM on the quick status filters; CURSOR clicks "Needs sensitivity review"; results: Lake reflection, Glacier creek and a scanned page | Needs sensitivity review | "When it finishes, open search. The quick filter Needs sensitivity review lists every flagged image that nobody has reviewed yet." |
| 8 | 1:18–1:38 | SCREEN viewer on Lake reflection; information card section "Enrichment"; ZOOM on the row "Sensitive content" with the pill "Needs review" and the detail "Checked by AI · {model} · 88% likely sensitive"; HIGHLIGHT in turn "Accept", "Unmark Sensitive" and the refresh icon "Check again with AI" | Sensitive content · Needs review | "Open one. In the Enrichment section of the information card, Sensitive content shows Needs review, the model, and how likely sensitive the image is. Accept agrees with the detector. Unmark Sensitive marks it safe. A person's decision always wins over the model." |
| 9 | 1:38–1:51 | CURSOR clicks "Unmark Sensitive"; the pill changes to "Overridden" and the detail ends "Reviewed by you"; the button now reads "Mark Sensitive"; CALLOUT on the refresh icon | Overridden · Reviewed by you | "The detector is wrong about this lake, so choose Unmark Sensitive. The row now reads Overridden, reviewed by you. Check again with AI reruns the check on this image." |
| 10 | 1:51–2:03 | SCREEN search filter panel; section "Sensitivity review" with "Review status": Reviewed, Needs review, Overridden, Flagged as sensitive, Check failed, Not checked; help line "Items flagged by detection wait for a review; overridden items keep a person’s decision." | Sensitivity review | "The Sensitivity review filter also finds reviewed, overridden, failed and unchecked images, so you can judge the detector on your own library." |
| 11 | 2:03–2:19 | SCREEN back in NSFW detection; CURSOR turns on "Hide detected NSFW assets" ("Hide privately flagged NSFW assets from library views unless the current session has been unlocked with the PIN."); Review changes → Save changes; cut to Locked (unlocked session) with the filter on "Detected" showing Glacier creek and the scanned page, badge "Sensitive"; Lake reflection is not there | Hide detected NSFW assets → Detected | "When the results look right, turn on Hide detected NSFW assets and save. Detections are then locked, hidden until you unlock with your PIN, and listed in Locked under Detected. Images you marked safe stay visible." |
| 12 | 2:19–2:31 | SPLIT: left, album Everyday still listing the scanned page when unlocked; right, the public shared link of Everyday without it | Same rules as any lock | "Detected items follow the same rules as anything you lock. They keep their albums, and partners and shared links never see them." |
| 13 | 2:31–2:42 | CARD headline "Keep in mind"; bullets: "Images only", "Classifiers can be wrong", "The nsfw tag is a search word, not the lock" | Keep in mind | "Detection covers images only, and a classifier can be wrong. The generated nsfw tag is only a search word; the lock is what hides things." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: PRIV-04 · Locked tags, people and pets | "Next up: Locked tags, people and pets." |

## Voice-over (clean)

Frameleaf can check your images for sensitive content. You review what it finds before anything is hidden.

Roll it out in three steps. Detect first. Review the results and tune the threshold. Only then turn on hiding.

[pause]

Open Settings, then Search & intelligence, and find NSFW detection. Turn on Detect NSFW images, and leave Hide detected NSFW assets off for now. The model is a dedicated classifier, not the description model.

NSFW threshold is the minimum score, from zero to one, that counts as a detection. It starts at zero point eight five. Review your changes and save.

New uploads are checked automatically. For the images you already have, open Job manager under Compute & jobs, find Locked-content detection and choose Run missing.

[pause]

When it finishes, open search. The quick filter Needs sensitivity review lists every flagged image that nobody has reviewed yet.

Open one. In the Enrichment section of the information card, Sensitive content shows Needs review, the model, and how likely sensitive the image is. Accept agrees with the detector. Unmark Sensitive marks it safe. A person's decision always wins over the model.

The detector is wrong about this lake, so choose Unmark Sensitive. The row now reads Overridden, reviewed by you. Check again with AI reruns the check on this image.

The Sensitivity review filter also finds reviewed, overridden, failed and unchecked images, so you can judge the detector on your own library.

[pause]

When the results look right, turn on Hide detected NSFW assets and save. Detections are then locked, hidden until you unlock with your PIN, and listed in Locked under Detected. Images you marked safe stay visible.

Detected items follow the same rules as anything you lock. They keep their albums, and partners and shared links never see them.

Detection covers images only, and a classifier can be wrong. The generated nsfw tag is only a search word; the lock is what hides things.

Next up: Locked tags, people and pets.

## Production notes

- Sensitive-content rule (STYLE-GUIDE.md section 6): every flagged example is a landscape or a plain document page. Seed the review states (flag, score) on those items rather than running the classifier on real sensitive material; nothing suggestive appears in any capture, thumbnail or search result.
- Labels verified in the build: group "NSFW detection" with "Detect NSFW images", "Hide detected NSFW assets", "NSFW detection model", "NSFW threshold", "Device"; defaults off, `onnx-community/nsfw_image_detection-ONNX`, 0.85, hide off (server config). Job manager queue "Locked-content detection" with "Run missing" and "Reprocess all". Search palette quick filter "Needs sensitivity review"; filter panel "Sensitivity review" / "Review status" with the six values shown. Information card section "Enrichment", row "Sensitive content", pills "Needs review", "Reviewed", "Overridden", "Not analysed", detail "Checked by AI · {model} · {n}% likely sensitive · Reviewed by you", buttons "Accept" (only while Needs review), "Mark Sensitive" / "Unmark Sensitive", refresh icon "Check again with AI".
- Doc vs build: the docs' single-asset actions are "Accept the current NSFW classifier result" and "Mark an asset as safe or NSFW"; the build labels them "Accept" and "Unmark Sensitive" / "Mark Sensitive". The docs say "Admins can review"; the build shows the review row to the photo's owner (images only). The docs' "Administration > Jobs > NSFW Detection > All" is Job manager → "Locked-content detection" → "Run missing" in the build, and the docs' settings path "Administration > Settings > Machine Learning Settings" is Settings → Search & intelligence.
- Rollout order is from image-enrichment.md "Recommended Rollout" and the privacy-suite rollout (detect, run the backfill, review and tune, then enable hiding). locked.md: turning hiding on later locks the unreviewed detections at that moment; Unmark Sensitive records the review as safe so detection never relocks the item. Beat 11 shows the lake staying visible because it was marked safe.
- When descriptions are also on, the description job runs the sensitive-content check first (jobs-workers.md); not narrated.
- "A person's decision always wins": review overrides are the effective source of truth for hiding (image-enrichment.md). Tags are "searchable metadata, not a security boundary".
- Outro card: "Next: PRIV-04 · Locked tags, people and pets".
