---
name: Supabase sync debounce bug
description: Active version changes can be silently dropped due to 15s debounce + tab suspension or concurrent push skip
type: project
---

Two bugs in `supabaseSyncStateSoon` (src/supabase.js:115-122) cause state changes (like switching active version) to silently fail to sync:

1. **15s debounce + tab suspension** — browser suspends tab before timeout fires, push never happens
2. **Silent skip on concurrent push** — `if (_pushRunning) return;` drops the change with no retry/reschedule

**Why:** User changed active version on one device but it never appeared on another. The sync path exists (`is_active` is pushed/pulled correctly), but these timing issues prevent the push from firing.

3. **Local persistence after cache bump** — user reported active version not surviving a SW cache bump even locally. Possible that `setActive()` change isn't making it to localStorage before the reload, or the normalization logic (app.js "enforce exactly one active version") is picking a different version via the `updatedAt` tiebreaker, overriding the user's choice.

**How to apply:** After the current refactor is complete:
- Fix `supabaseSyncStateSoon` — shorter debounce or immediate push for critical changes, re-queue on `_pushRunning` conflict, add `visibilitychange` flush before tab suspends
- Investigate whether `setActive()` → `saveState()` round-trip survives cache bumps, and whether the normalization tiebreaker can override a deliberate user choice
