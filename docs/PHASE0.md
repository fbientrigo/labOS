# Phase 0 — Evidence Ledger Experiment

## Hypothesis

A tiny explicit capture tool can improve experimental memory without becoming documentation work.

## Primitive

The durable primitive is an **Event**, not a Session.

A session is only a convenient human interval. Notes can exist without one. Every event records an offset-aware timestamp, current working directory, active project/session when present, and an event-specific payload.

## Events in Phase 0

- `session_start`
- `note`
- `checkpoint` with `working` or `broken`
- `artifact`
- `session_end`

The LabOS setup and daily log extension adds append-only `setup_snapshot`,
`measurement`, `entry_revision`, `tag_definition`, `asset_rename`, and
`markdown_edit` events. Measurements and observations retain their original
setup snapshot; corrections are revisions that point to the original event.
Occurrence time is stored separately from the event's save timestamp.
Checkpoint Git capture has separate save-time provenance (`git_captured_at`
and `git_capture_session_id`); a historical association never backdates Git.
Markdown logs are generated views, with stable IDs and managed entry markers;
notes outside the managed block remain user-owned.

Session Record derived data is version 4. It includes effective, date-filtered
entries and their revision histories while retaining the raw event stream and
the original Git snapshots. Older evidence is not supplemented with guessed
setup, tag, or measurement data.

Git state is captured on session boundaries and checkpoints because those are the moments where state comparison has the highest expected value.

## What to measure

For 10 real lab days, do not add product features. Record only:

1. Did you start LabOS spontaneously?
2. Did capture interrupt the experiment?
3. Did it recover something you would otherwise have lost?
4. Did you need to backfill or clean metadata later?
5. Which real retrieval questions could not be answered?

## Kill / reduce criteria

Reduce LabOS to scripts or stop the project if any of these becomes normal:

- evidence is captured only after the work;
- another note tool is consistently used first and copied later;
- maintaining structure becomes a recurring task;
- important state changes are still mostly uncaptured;
- captured evidence does not improve resume/compare/recovery.

## Deferred until evidence justifies it

- web UI / FastAPI;
- SQLite + FTS5;
- semantic embeddings;
- Dreams / agent consolidation;
- stable facts and proposals;
- resource QR codes;
- project-specific collectors beyond Git;
- automated known-good/staleness/procedure mining.

The first likely additions should be driven by concrete failures observed during the experiment, not by architecture planning.
