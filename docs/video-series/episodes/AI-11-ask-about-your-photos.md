# AI-11 · Ask about your photos

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | How-to |
| Target length | 2:15 |
| Audience | Frameleaf users who would rather ask a question than build a filter, and the administrators who control it |
| Features demonstrated | Ask about your photos on the search page, Try a search examples, match count, What Frameleaf searched for, smart-search sparkle, named people and pets as real filters, places after in, at or near, relative dates and months, receipts, screenshots and documents through text and file-name search, notes for names or places that can't be matched, answer cap and Locked content, Enable Ask Search and Maximum Ask Search results, turned-off message |
| Source docs | docs/docs/features/searching.md |
| Capture checklist | Signed in as Taylor (admin), dark theme. Smart search on; Ask Search at its defaults (on, 100). Jamie named on the People page; Max set up on the Pets page. Photos from summer 2025 and August 2026 (Hiking with Jamie, Ridge trail, Summit view); Dad and Max and Emma at the lake geotagged at Lake Louise; three receipt photos dated 2024 with readable text; two screenshots from last month with "Screenshot" in their file names. Settings → Search & intelligence reachable. A second browser profile on a test server with Ask Search turned off for the last beat. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:12 | LOWER-THIRD "Ask about your photos · Frameleaf AI"; SCREEN the search page's large frosted panel with the field "Ask about your photos…" | Ask about your photos | "Ask about your photos lets you search the way you talk. It runs on your own server, against your own library." |
| 3 | 0:12–0:24 | SCREEN library; CURSOR presses / and the search palette opens; the field stays empty; CURSOR clicks "Show results"; the search page opens on the Ask panel with "Try a search" rows: photos from last summer, receipts from last year, screenshots from last month, favorite videos since 2020 | Show results → Try a search | "Open search, leave the field empty and choose Show results. The search page opens with a large question field and some ideas under Try a search." |
| 4 | 0:24–0:38 | CURSOR clicks "photos from last summer"; the status beside the field reads "Searching…", then "{n} matches"; results grid below; ZOOM on the box "What Frameleaf searched for" with its one-line explanation | What Frameleaf searched for | "Choose photos from last summer. The count appears beside the field, and What Frameleaf searched for explains how the question was read: which search ran and which filters it used." |
| 5 | 0:38–0:52 | CURSOR clears the field and types "Jamie hiking in August 2026", Enter; results show Hiking with Jamie and Ridge trail; ZOOM on the indigo sparkle beside the heading, tooltip "Read by smart search" | Jamie hiking in August 2026 | "People you have named become a real person filter. Jamie hiking in August 2026 finds Jamie, in that month, ranked by smart search. The sparkle means smart search read the question." |
| 6 | 0:52–1:04 | CURSOR types "Max at Lake Louise", Enter; results show Dad and Max at the lake | Max at Lake Louise | "Pets work the same way, and a place after in, at or near becomes a location filter. Max at Lake Louise finds the dog at the lake." |
| 7 | 1:04–1:19 | CURSOR types "receipts from 2024", Enter; three receipt photos; the explanation now starts "Used metadata and OCR search"; quick cut to "screenshots from last month" with two screenshots | Receipts · Screenshots | "Receipts, screenshots and documents switch to searching text and file names instead. Receipts from 2024 looks for receipt words read from your photos in that year. Screenshots from last month looks for screenshot file names." |
| 8 | 1:19–1:31 | CURSOR types "photos of Alex at the beach"; under the explanation, two muted notes: one that the name is searched semantically, one that "the beach" couldn't be resolved to a known location | Notes | "When a name or place can't be matched, Ask still searches, and a note under the explanation tells you what it left out." |
| 9 | 1:31–1:43 | CARD headline "Answers"; bullets: "Up to 100 by default", "Locked items stay out", "Only what you can access" | Answers | "Answers stop at one hundred by default, and Locked items and things you can't access never appear in answers or counts." |
| 10 | 1:43–1:58 | SCREEN Settings → Search & intelligence; the group "Search models & suggested tags"; HIGHLIGHT "Enable Ask Search" (on) with "Ask questions about your photos using local search."; ZOOM on "Maximum Ask Search results" 100 | Enable Ask Search · Maximum Ask Search results | "Administrators control it under Settings, Search & intelligence, in Search models & suggested tags. Enable Ask Search is on by default, and Maximum Ask Search results sets the cap." |
| 11 | 1:58–2:12 | SCREEN second browser on the test server; the Ask panel field greyed, with the note "Ask about your photos is turned off on this server. An administrator can turn it on in Machine learning settings." | Turned off | "Turned off, the panel says so rather than offering a field that can't answer. Ask appears only while smart search is on." |
| 12 | 2:12–2:15 | LOGO OUTRO | Next: AI-12 · Documents and text in photos | "Next up: Documents and text in photos." |

## Voice-over (clean)

Ask about your photos lets you search the way you talk. It runs on your own server, against your own library.

[pause]

Open search, leave the field empty and choose Show results. The search page opens with a large question field and some ideas under Try a search.

Choose photos from last summer. The count appears beside the field, and What Frameleaf searched for explains how the question was read: which search ran and which filters it used.

[pause]

People you have named become a real person filter. Jamie hiking in August 2026 finds Jamie, in that month, ranked by smart search. The sparkle means smart search read the question.

Pets work the same way, and a place after in, at or near becomes a location filter. Max at Lake Louise finds the dog at the lake.

Receipts, screenshots and documents switch to searching text and file names instead. Receipts from 2024 looks for receipt words read from your photos in that year. Screenshots from last month looks for screenshot file names.

When a name or place can't be matched, Ask still searches, and a note under the explanation tells you what it left out.

[pause]

Answers stop at one hundred by default, and Locked items and things you can't access never appear in answers or counts.

Administrators control it under Settings, Search & intelligence, in Search models & suggested tags. Enable Ask Search is on by default, and Maximum Ask Search results sets the cap.

Turned off, the panel says so rather than offering a field that can't answer. Ask appears only while smart search is on.

Next up: Documents and text in photos.

## Production notes

- Labels verified in the build (SearchAsk, search page, SearchLabelsSection): placeholder "Ask about your photos…"; status "Searching…" then "{n} matches" or "No matches in your library."; heading "What Frameleaf searched for" with the sparkle titled "Read by smart search" (shown only when smart search answered); examples under "Try a search": "photos from last summer", "receipts from last year", "screenshots from last month", "favorite videos since 2020"; failure "Frameleaf couldn't answer that just now." with "Try again"; turned-off text as in beat 11. Admin group "Search models & suggested tags" with "Enable Ask Search" (default on) and "Maximum Ask Search results" (default 100, 1–1000; help: "Access and Locked-content restrictions still apply to results and counts.").
- How to reach it: the Ask panel is the search page's empty state. Submitting an empty search palette ("Show results") opens it; the phone tab bar's Search opens the same palette. The panel shows only while search and smart search are on.
- The explanation line is the server's own text, for example "Used local smart search with takenAfter, takenBefore, type filters." or "Used metadata and OCR search with …". It shows raw filter names; keep the ZOOM short and do not read it aloud. The VO describes what it tells you, not its wording.
- Parsing (server buildAskSearchPlan): relative ranges (today, this or last week, month, year), "last summer" (June to August of last year), named months with years, "since/after/before" a year, favorites, photos or videos, a place after in, near, around or at becomes a city filter; receipts or invoices and documents or forms use OCR text, screenshots use the file name "Screenshot"; named people and pets resolve to real filters. Notes include "People names are searched semantically until Ask Search can resolve names to person IDs." and "Couldn't resolve "the beach" to a known location — showing results without a location filter." "Alex" is an invented, unnamed person used only to trigger the note.
- Confirm the capture server's reverse geocoding names the lake photos' city "Lake Louise"; if it names another place, change the example to that city in beat 6 and in the VO.
- Doc vs build: searching.md names the feature "Ask Search" and lists "photos of Alice in Banff last summer"; the page is titled "Ask about your photos". The turned-off message says "Machine learning settings"; the setting sits in Settings → Search & intelligence (the section card is "Machine Learning Settings"), which is what the VO names.
- Outro card: "Next: AI-12 · Documents and text in photos".
