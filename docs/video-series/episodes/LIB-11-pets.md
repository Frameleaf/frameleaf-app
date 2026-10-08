# LIB-11 · Pets

| Field | Value |
| --- | --- |
| Series | Your library |
| Type | How-to |
| Target length | 2:15 |
| Audience | Pet owners who want their animals named and found like the people in their library |
| Features demonstrated | Pets page (Explore → Pets), New pet (Name, Kind of animal, Birthday), pet card, Mark a pet in the viewer (Pets section, Add, pet name for the whole photo, Mark a region…, Whole photo, Save), Recognition panel (Look for pets, where it runs, progress), Suggestions (Is this Max?, confidence, Yes / Someone else / No, Undo), card menu (Merge into…, Hide pet, Show hidden), pet page (All pets, Decisions, Remove), Moments with a pet in Memories |
| Source docs | docs/docs/features/facial-recognition.md, web Pets page (see inventory) |
| Capture checklist | Taylor signed in; no pets at the start; photos of Max the golden retriever across the library ("Dad and Max", "Family hike", "Cabin life" and at least 40 more); pet recognition set to run on this server; a duplicate pet "Buddy" created for the merge beat; at least five confirmed photos of Max in August 2026 and the memory job run so "Moments with Max" exists; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "Pets · Your library". SCREEN: sidebar Explore → Pets; page "Pets" with the empty state "No pets yet. Add one to start naming the animals in your photos."; toolbar Find a pet and "+ New pet". | LOWER-THIRD; CALLOUT "Explore → Pets" | "Pets get their own page, separate from People. Open Pets, under Explore. You add each pet yourself, then show Frameleaf which photos they are in." |
| 3 | 0:15–0:28 | CURSOR clicks New pet; dialog "New pet": Name "Max", Kind of animal (menu: Dog, Cat, Bird, Rabbit, Horse, Small mammal, Reptile, Fish, Other) set to Dog, Birthday; CURSOR clicks New pet; toast "Pet added"; card "Max · Dog · 5 years old · No confirmed photos". | CALLOUT "Name · Kind of animal · Birthday" | "Choose New pet. Give a name, the kind of animal, and a birthday if you like, then choose New pet again. Max now has a card, with no confirmed photos yet." |
| 4 | 0:28–0:46 | SCREEN: viewer on "Dad and Max", information card section "Pets" with "No pets marked in this photo."; CURSOR clicks Add; menu: Max, Mark a region…; picks Mark a region…; dialog "Mark a pet": Pet "Max · Dog", Whole photo checkbox, Place a region; CURSOR drags a box around Max; Save; toast "Max added to this photo" with Undo. Inset: on "Family hike", Add → Max marks the whole photo at once. | CALLOUT "Pets · Add"; CALLOUT "Mark a region…"; CALLOUT "Whole photo" | "Open a photo of your pet and find Pets in the information card. Choose Add, then the pet's name to mark the whole photo, or Mark a region to draw around the animal. Tick Whole photo instead when a region does not fit." |
| 5 | 0:46–1:02 | SCREEN: Pets page, panel "Recognition" under the grid: "Recognition runs on this server."; CURSOR clicks Look for pets; toast "Looking for your pets"; progress "Looking through 1,240 of 3,100 photos"; then "Looked through 3,100 photos and made 14 suggestions." Inset before marking: "Mark each pet in a photo first. Recognition learns from the photos you confirm." | CALLOUT "Look for pets"; CALLOUT "Recognition runs on this server." | "Recognition learns from the photos you confirm, so mark a few first. Then, under Recognition, choose Look for pets. The panel says where the work runs, here on this server, and counts the photos as it looks." |
| 6 | 1:02–1:17 | Panel "Suggestions · 14 suggestions"; a row with a photo: "Is this Max?", "92% confident · … · Looks like a dog", buttons Yes, Someone else, No. CURSOR clicks Yes; toast "Marked as Max" with Undo. Next row: CURSOR clicks No; toast "Suggestion ignored". HIGHLIGHT Someone else (opens "Assign to" with Choose a pet). | CALLOUT "Is this Max?"; CALLOUT "Yes · Someone else · No" | "Suggestions ask, Is this Max? Each shows how confident the match is. Choose Yes to confirm, No to ignore it, or Someone else to give it to another pet. Every answer comes with Undo." |
| 7 | 1:17–1:35 | CURSOR opens the menu on the card "Buddy": Edit name, Edit details, Favorite, Hide pet, Merge into…, Delete pet; picks Merge into…; dialog "Merge into…" with "Everything you confirmed about Buddy moves to the pet you choose, and Buddy is removed." and Keep this pet: Max; Merge; toast "Pets merged". Then Hide pet on a neighbour's cat; the card leaves the grid; checkbox "Show hidden (1)" appears. | CALLOUT "Merge into…"; CALLOUT "Hide pet · Show hidden" | "Each card's menu handles the rest. If you made the same pet twice, Merge into moves everything you confirmed to the pet you keep. Hide pet takes a pet off the page and out of search suggestions, and Show hidden brings it back into view." |
| 8 | 1:35–1:47 | CURSOR opens Max: "All pets" back link, "Dog · 5 years old · 42 confirmed photos", grid of photos; Decisions "42 decisions" expanded: "In this photo · Marked by you · Region", "In this photo · From a suggestion · Whole photo"; CURSOR clicks Remove on one; toast "Decision removed" with Undo. | CALLOUT "Decisions"; CALLOUT "Remove" | "Max's own page shows every confirmed photo. Decisions lists each one, marked by you or from a suggestion, and Remove takes back any that are wrong." |
| 9 | 1:47–2:02 | SCREEN: Memories page; a card with the overline "Pets", title "Moments with Max", "18 items"; CURSOR clicks Play; the memory player opens on Max in the meadow with a slow Ken Burns move. | CALLOUT "Moments with Max" | "Once Max has at least five confirmed photos in a month, Memories can make a story called Moments with Max. Only named pets get one, and hidden pets are left out." |
| 10 | 2:02–2:12 | CARD "Pets": bullet 1 "Add your pets"; bullet 2 "Mark a few photos"; bullet 3 "Review the suggestions". | CARD | "Add your pets, mark a few photos, and let Recognition suggest the rest." |
| 11 | 2:12–2:15 | LOGO OUTRO | Next: LIB-12 · Map and Places | "Next up: Map and Places." |

## Voice-over (clean)

Pets get their own page, separate from People. Open Pets, under Explore. You add each pet yourself, then show Frameleaf which photos they are in.

Choose New pet. Give a name, the kind of animal, and a birthday if you like, then choose New pet again. Max now has a card, with no confirmed photos yet.

Open a photo of your pet and find Pets in the information card. Choose Add, then the pet's name to mark the whole photo, or Mark a region to draw around the animal. Tick Whole photo instead when a region does not fit.

Recognition learns from the photos you confirm, so mark a few first. Then, under Recognition, choose Look for pets. The panel says where the work runs, here on this server, and counts the photos as it looks.

Suggestions ask, Is this Max? Each shows how confident the match is. Choose Yes to confirm, No to ignore it, or Someone else to give it to another pet. Every answer comes with Undo.

Each card's menu handles the rest. If you made the same pet twice, Merge into moves everything you confirmed to the pet you keep. Hide pet takes a pet off the page and out of search suggestions, and Show hidden brings it back into view.

Max's own page shows every confirmed photo. Decisions lists each one, marked by you or from a suggestion, and Remove takes back any that are wrong.

Once Max has at least five confirmed photos in a month, Memories can make a story called Moments with Max. Only named pets get one, and hidden pets are left out.

Add your pets, mark a few photos, and let Recognition suggest the rest.

Next up: Map and Places.

## Production notes

- Interface vs docs: facial-recognition.md does not mention pets, and no user doc covers the Pets page. Every label here comes from the current interface: "Pets", "Find a pet", "New pet", "Kind of animal", "Birthday", "Pet added", "Mark a pet", "Pet", "Whole photo", "Place a region", "Mark a region…", "Recognition", "Look for pets", "Stop looking", "Suggestions", "Is this {name}?", "Yes", "Someone else", "No", "Marked as {name}", "Suggestion ignored", "Merge into…", "Keep this pet", "Pets merged", "Hide pet", "Show hidden ({n})", "All pets", "Decisions", "Decision removed". Flag the docs for a Pets page.
- The Recognition panel says where the work runs. This episode shows only "Recognition runs on this server." The other states name a computer on your network or Frameleaf Cloud; the cloud route belongs to the Frameleaf Cloud series and is not shown here. If no processing destination is chosen, the panel reads "Recognition is unavailable:" with a reason; administrators get "Open processing settings" (Compute & jobs → Workload destinations).
- "Look for pets" stays disabled until at least one pet is confirmed in a photo; the inset in beat 5 shows the prompt. "Someone else" is disabled when there is only one pet, so keep Buddy until beat 6 is captured, then merge him in beat 7.
- The suggestion line reads "{percent}% confident · {model} {revision} · Looks like a {species}"; the species word comes from the model untranslated. Blur the model name if it reads as a vendor name.
- The hidden badge's tooltip reads "Hide pet". A hidden pet's page notes "Hidden on the Pets page and in search suggestions". The Pets grid lists favorites first.
- "Moments with a pet" is a Memories story, not a control on the Pets page: title "Moments with {name}", overline "Pets". The memory job makes one per named pet per month with at least five confirmed photos. "Show less of Max" and "Show fewer pet stories" are in the memory card's menu (LIB-14).
- Delete pet ("The photos stay in your library, but everything you confirmed about this pet is removed.") is available in the card menu but not demonstrated.
- The Pets section in the viewer shows only to the photo's owner, never on a shared link, and on Locked photos only while unlocked.