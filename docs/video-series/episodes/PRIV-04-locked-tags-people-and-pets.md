# PRIV-04 · Locked tags, people and pets

| Field | Value |
| --- | --- |
| Series | Private by design |
| Type | How-to |
| Target length | 2:15 |
| Audience | Frameleaf users who want a whole subject, not one photo at a time, kept out of everyday browsing |
| Features demonstrated | Access & security → Locked tags & people, Unlock Locked settings, Apply Locked rules to (My photos and videos, All photos and videos I can access), Tags with Find or create a tag and Create, nested tags Locked through a parent, People and Pets, Save Locked rules and the conflict draft, Hide Locked content, Suppressed content view (Timeline and Albums tabs) keeping album context, rules shape only your own view, unavailable entries |
| Source docs | docs/docs/features/fork-privacy-suite.md, docs/docs/features/locked.md |
| Capture checklist | Signed in as Taylor with a PIN, dark theme, session locked at the start. Tag tree with "Documents" and the nested tags "Documents/Insurance" and "Documents/Receipts" on six plain scanned document pages that sit in the Everyday album. People list with Jamie, Emma and Taylor and the Pets list with Max visible but never ticked. Settings → Access & security. A second tab ready to open /suppressed after unlocking. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "Locked tags, people and pets · Private by design"; SCREEN Tags view with "Documents" expanded to "Insurance" and "Receipts", tiles of plain scanned pages | A whole subject | "Some private things are a whole subject, not one photo: medical records, legal papers, a private project. Locked tags and people hide a subject at once." |
| 3 | 0:14–0:27 | SCREEN Settings → Access & security, group "Locked content"; CURSOR clicks "Locked tags & people"; the panel shows a lock icon, "Locked tags and people" and "Unlock to view or change the photos and videos you keep private."; CURSOR clicks "Unlock Locked settings"; the PIN dialog fills with dots | Locked tags & people → Unlock Locked settings | "Open Settings, then Access & security, then Locked tags & people. The rules are private too, so choose Unlock Locked settings and enter your PIN." |
| 4 | 0:27–0:41 | Panel revealed with the line "Locked settings are revealed for this session." and the button "Hide Locked content"; ZOOM on "Apply Locked rules to" with its two options "My photos and videos" and "All photos and videos I can access" | Apply Locked rules to | "First, Apply Locked rules to. My photos and videos covers only what you own. All photos and videos I can access also covers partners' photos and albums shared with you." |
| 5 | 0:41–0:55 | Column "Tags": CURSOR types "Documents" in "Find or create a tag" and ticks it; the nested tags below show ticked and greyed with "Locked through Documents"; CURSOR types "Legal" and the button "Create “Legal”" appears; CURSOR clicks it | Tags · Locked through Documents | "Under Tags, find a tag and tick it, or type a new name and create it. A tag nested inside a locked tag is locked through it, so Documents covers everything beneath." |
| 6 | 0:55–1:04 | Columns "People" (Jamie, Emma, Taylor with "Find a person") and "Pets" (Max); CURSOR hovers the checkboxes without ticking any | People · Pets | "People and Pets work the same way: tick one, and every photo of them is locked." |
| 7 | 1:04–1:14 | CURSOR clicks "Save Locked rules"; toast "Locked rules saved."; inset CALLOUT with the conflict notice "These rules changed elsewhere. Your draft is kept until you reload." and "Discard draft and reload rules" | Save Locked rules | "Choose Save Locked rules. If they changed on another device meanwhile, your draft is kept until you choose to reload." |
| 8 | 1:14–1:28 | CURSOR clicks "Hide Locked content"; cut to the timeline: the scanned pages are gone; cut to the album Everyday, whose count drops by six | Hide Locked content | "Choose Hide Locked content. Photos with those tags leave the timeline, search and albums. Nothing is removed from any album; it is simply not shown until you unlock." |
| 9 | 1:28–1:48 | After unlocking again, the address bar shows the server address followed by /suppressed; page "Suppressed content" with tabs "Timeline" and "Albums"; Timeline lists the six pages; CURSOR clicks "Albums": the card Everyday; CURSOR opens it and only its six hidden pages show | Suppressed content · Timeline · Albums | "To review what your rules hide, unlock and add slash suppressed to your server's address. Suppressed content has two tabs. Timeline lists every hidden item. Albums shows which albums hold them, so each item keeps its album context." |
| 10 | 1:48–2:02 | CARD headline "Your rules, your view"; bullets: "Apply to what you see, on every device", "Partners and shared links are unaffected", "To hide from everyone: Mark Sensitive" | Your rules, your view | "Locked rules shape what you see, on every device. They don't change what partners or shared links see. To keep one photo from everyone, mark it sensitive instead." |
| 11 | 2:02–2:12 | SCREEN the rules panel with a row "Unavailable tag" and its note "No longer in your library. It stays in your rules until you remove it." | Unavailable | "If a tag or person is deleted, it stays in your rules as unavailable until you remove it, so nothing is revealed by accident." |
| 12 | 2:12–2:15 | LOGO OUTRO | Next: PRIV-05 · Location privacy when you share | "Next up: Location privacy when you share." |

## Voice-over (clean)

Some private things are a whole subject, not one photo: medical records, legal papers, a private project. Locked tags and people hide a subject at once.

[pause]

Open Settings, then Access & security, then Locked tags & people. The rules are private too, so choose Unlock Locked settings and enter your PIN.

First, Apply Locked rules to. My photos and videos covers only what you own. All photos and videos I can access also covers partners' photos and albums shared with you.

Under Tags, find a tag and tick it, or type a new name and create it. A tag nested inside a locked tag is locked through it, so Documents covers everything beneath.

People and Pets work the same way: tick one, and every photo of them is locked.

Choose Save Locked rules. If they changed on another device meanwhile, your draft is kept until you choose to reload.

[pause]

Choose Hide Locked content. Photos with those tags leave the timeline, search and albums. Nothing is removed from any album; it is simply not shown until you unlock.

To review what your rules hide, unlock and add slash suppressed to your server's address. Suppressed content has two tabs. Timeline lists every hidden item. Albums shows which albums hold them, so each item keeps its album context.

[pause]

Locked rules shape what you see, on every device. They don't change what partners or shared links see. To keep one photo from everyone, mark it sensitive instead.

If a tag or person is deleted, it stays in your rules as unavailable until you remove it, so nothing is revealed by accident.

Next up: Location privacy when you share.

## Production notes

- Sensitive-content rule: the only items hidden on screen are plain scanned document pages. No person or pet is ticked in the capture; the People and Pets columns are shown untouched.
- Labels verified in the build (LockedRulesPanel, suppressed routes): section "Locked tags & people" in Access & security, group "Locked content"; locked state "Locked tags and people", "Unlock to view or change the photos and videos you keep private.", "Unlock Locked settings" (or "Set up your PIN to continue." with "PIN settings"); revealed state "Locked settings are revealed for this session." with "Hide Locked content"; "Apply Locked rules to" with "My photos and videos" / "All photos and videos I can access"; columns "People" ("Find a person"), "Tags" ("Find or create a tag", "Create “{name}”", "Locked through {tag}"), "Pets"; "Discard rule changes", "Save Locked rules"; toasts and notices "Locked rules saved.", "These rules changed elsewhere. Your draft is kept until you reload.", "Discard draft and reload rules"; unavailable rows "Unavailable tag" / "Unavailable person" / "Unavailable pet" with "No longer in your library. It stays in your rules until you remove it."; page "Suppressed content" with tabs "Timeline" and "Albums", empty states "No suppressed content to show." and "No albums contain suppressed content."
- Doc vs build: the privacy-suite page still calls this "Account settings > Suppressed content"; the build's section is Access & security → "Locked tags & people", and pets are included (production extension). The docs' `/suppressed` view is still the PIN-guarded "Suppressed content" page, but in the current build it is not linked from the sidebar (unlinked until the Locked view also lists rule matches), which is why the VO gives the address. If a later build links it or folds it into Locked, re-record beat 9.
- Rules are the viewer's own preferences (server: each session's hidden-content filter comes from that user's suppression settings). They hide content in your own sessions on every client, including the mobile app, and do not change what partners, album members or shared links see. Mark Sensitive (PRIV-02) is the control that hides an item from everyone.
- Scope "All photos and videos I can access" applies the rules to other people's items you can see (partner libraries, shared albums and spaces); "My photos and videos" applies only to items you own.
- The rules and the rule ids are only shown to an unlocked session; a session that locks during a save drops the draft and asks to unlock again.
- Outro card: "Next: PRIV-05 · Location privacy when you share".
