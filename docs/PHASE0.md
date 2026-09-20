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
