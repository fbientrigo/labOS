# LabOS Obsidian UI — Observatory / Field Notebook

## Purpose

LabOS is an evidence ledger, not a simulated system monitor. The **WIRED / OBSERVATORY**
reference is a *visual language*, not executable UI code.

The essential interaction is:

1. **Capture:** start or continue work, write a note, checkpoint working/broken, record a measurement, paste an image.
2. **Inspect:** select a day, filter/search evidence, inspect timeline and revisions.
3. **Context:** edit the physical device graph and approved knowledge without silently modifying existing evidence.
4. **Handoff:** derive and review a report from real recorded events.

Obsidian remains the host. SQLite/event history, Python CLI, and Markdown logs remain unchanged.
The interface never fabricates system health, metrics, measurements, or connection status.

## Visual contract

- Off-white paper (#fbfbfa), white panels, nearly black ink (#18181b), sharp 1px rules.
- Cyan (#0284c7) only for *selected/interactive* states, not decorative glows.
- Dark-mode tokens provide legible high-contrast equivalents.
- Monospaced typography is preferred; local fonts are valid, no external font or Tailwind dependency.
- Square corners, no gradients, no fake graphs, no pulsing telemetries, no oversized hero cards.
- All CSS is scoped under `.labos-view`; never restyle the vault or other plugins globally.
- Keep task actions prominent and administrative controls quieter.
- Respect narrow Obsidian side panes, keyboard focus, and reduced motion.

Implementation is in `obsidian/styles.css`, with DOM grouping in `obsidian/src/view.ts`.
The original `cpp_root_observatory_syllabus.html` is a *separate design reference*;
it must not be embedded into the runtime Obsidian plugin.

## Functional regression checklist (manual in Obsidian)

- [ ] Narrow sidebar and wide full-pane layouts; light and dark themes.
- [ ] Start a new session and continue last work, with and without a hardware setup.
- [ ] Capture plain note; Enter-to-save and Shift+Enter; survive a refresh with unsaved draft.
- [ ] Working/broken checkpoints, shorthand, current/voltage measurements.
- [ ] Paste image, link Obsidian note, open/save/sync a session note.
- [ ] Day picker, previous/next/today, search, tag/session filters, pagination.
- [ ] Revise an event; inspect revision history and recorded setup at measurement time.
- [ ] Add/select/replace/remove device; inspect approved device facts and power profiles.
- [ ] Drag a setup card, connect ports, discard changes, commit setup; do not commit a stale draft.
- [ ] Generate/cancel factual and AI-assisted reports; verify evidence provenance remains visible.
- [ ] Trigger a backend/doctor error; error message and retry remain readable.
- [ ] Navigate entire panel by keyboard with visible focus rings.

## Automated checks

From repository root:

```bash
python -m pytest
cd obsidian
npm ci
npm run build
npm test
```

Visual interaction still requires actual Obsidian desktop verification.
Do not treat passing unit tests as proof that the canvas or narrow layout works.
