---
title: Automatic and scheduled workflows
---

Workflows apply your installed actions to matching photos and videos in your own library. Open **Settings → Utilities → Workflows**, choose **Automate this search** from Save search, or choose **Automatically add matching photos** in an album's menu. The album shortcut starts with an additive album action; choose the conditions before enabling it.

Choose **After every matching change** to run again after supported metadata, tag, rating, people, pet, or completed-enrichment changes while the item still matches. Workflow-generated changes carry their ancestry, so the same workflow cannot process the same item twice within one causal chain. Other legacy triggers remain available.

Choose **Scheduled only**, or add a schedule to a change-driven workflow. Hourly, daily, weekly, and five-field cron schedules use the displayed server timezone. The saved workflow shows its next occurrence. Missed occurrences coalesce into one catch-up batch; batches of the same workflow do not overlap. **Run now** runs the saved, enabled definition against all eligible matches.

## Conditions and preview

Search conditions are copied into the workflow. Editing or deleting the saved search does not change the workflow. Explicit dates, including dates previously compiled into a saved search, stay fixed. Choose a rolling period explicitly to resolve it relative to each execution. Semantic matching uses the configured maximum distance for every eligible item, rather than a limited page of ranked search results. Lower distances require closer matches.

**Check and preview** shows matching counts, examples, and intended steps without invoking actions, plugins, or webhooks. The server checks conditions and permissions again before executing actions. Items that no longer match are skipped. Locked, suppressed, trashed, other-owned, or not-yet-ready items cannot bypass workflow eligibility checks.

## Progress and cancellation

Batch progress appears under **History**. Refresh to see completed, skipped, and failed items. Batches retain their checkpoints across restart. Cancelling a batch, pausing or deleting its workflow, or changing its definition stops pending execution; an action already in progress may finish. Completed actions are retained. Album additions never remove existing members and adding an existing member is idempotent.

External actions can have side effects. Review their conditions and retry behavior before enabling them, especially with repeat-on-change rules. Existing action validation, credential protection, and retry semantics still apply.

## Compatibility

Imported workflows start paused. Unknown imported fields and unavailable plugin steps are retained. A schedule import needs valid conditions and scheduling configuration before it can be enabled. Exports omit credentials. Older servers retain their existing workflow controls; update the server to use schedules, rule previews, and batch runs.
