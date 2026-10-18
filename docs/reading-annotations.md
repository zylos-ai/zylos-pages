# Reading annotations

Markdown readers and script-enabled sandboxed HTML readers support local text
annotations. Selecting text reveals a compact **+ Note** button beside the
selection. It opens an anchored editor with the selected quote, Save, Cancel
and Close. Closing, canceling, Escape, clicking outside, switching to the
summary, or selecting another passage discards an unsaved draft and releases
the selection for the next annotation. Canceling an edit preserves its saved
content. Storage errors and stale-edit conflicts retain the draft for recovery.
The lower-right **Annotations**
control shows the count and provides locate, edit, individual delete, confirmed
clear, and **Prompt**. Its header stays visible while long annotation lists scroll
inside the height-limited panel. Clicking a saved highlight opens the comment beside
its original text with an Edit action. Overlapping annotations remain available
in the summary. An unmatched saved quote can still be edited in the summary.
Delete and Clear all open a small floating confirmation beside their action,
without shifting the list. Cancel receives focus first; Escape or an outside
click cancels and returns focus to the action. The red Delete or Delete all
button applies the existing record/scope snapshot checks before removing data.

Prompt first opens a full feedback preview. Copy Prompt copies exactly that
preview, using compact Markdown: the document title, a safe document reference,
an instruction to process each annotation and clarify ambiguity, then consecutive
numbered quotes and comments. Multiline content is preserved without per-item
headings or blank separators. Internal positions and record identifiers are not
exported. Share readers export the title instead of a bearer URL. Clipboard
rejection selects the complete preview for manual copying; long prompts are
never truncated.
The copy button shows a spinner and Copying while a write is pending, then a
green check with Copied or a red Copy failed state. Failure allows retry and
selects the full prompt for manual copying. Large prompts show Copy manually.
Closing or reopening the preview resets its feedback and ignores older pending
clipboard results. Reduced-motion settings disable the icon animations.

## Storage and recovery

- Records remain in the current browser profile's localStorage. They are not
  uploaded, automatically sent to an Agent, synchronized across devices, or
  guaranteed to survive site-data clearing or private browsing.
- Mount path, stable page ID and owner/share context isolate storage. Each share
  has its own non-secret hashed scope. Theme keys and other pages are untouched.
- Each annotation has its own key. A storage event refreshes other tabs. Editing
  and deleting check the previously read record; conflicts retain the draft.
  Concurrent writes to one record still have localStorage's last-write behavior.
- Quote, comment and page limits are 10,000 UTF-16 units, 4,000 units and 200
  records. Quota/storage failures retain the editor draft. Corrupt records are
  reported and preserved until an explicit scope clear.
- Recovery verifies the original position against a text revision, then uses a
  unique quote and its surrounding context. Missing/ambiguous references remain
  available in the list and export, with an explicit location warning. They are
  not highlighted at an arbitrary occurrence.

## HTML boundaries

The trusted reader shell owns comments, editing and persistence. A dedicated
MessageChannel exchanges only selections, anchor IDs and positioning data with
the current iframe. It never exposes comments, storage keys or share credentials
to the artifact and does not invoke the backend bridge. The existing sandbox,
CSP and page capabilities remain in force.

HTML with scripts disabled, HTML with the sandbox disabled, and downloadable
non-DOM attachments do not support annotation selection. Unsupported HTML
configurations show an unavailable reader control. A hostile artifact can alter
its own text or selection reports: quotes are user-confirmed reading snapshots,
not authenticated content proofs.

## Verification

Run the normal suite with `npm test`. Browser tests activate when both
`PAGES_PLAYWRIGHT_CORE_PATH` and `PAGES_CHROMIUM_PATH` point to installed
Playwright and Chromium. `PAGES_ANNOTATIONS_EVIDENCE_DIR` optionally retains
screenshots. Browser viewport/touch emulation does not prove real iOS Safari or
Android Chrome long-press selection; those require separate device validation.
