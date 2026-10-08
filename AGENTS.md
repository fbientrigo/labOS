# AGENTS.md — LabOS engineering constraints

LabOS is deliberately vulnerable to overengineering. Preserve the experiment before expanding the architecture.

## Product objective

Make normal experimental work leave enough cheap evidence to later reconstruct state, changes, and artifacts.

## Product philosophy

- **Fit the user's notes; do not replace them.** Users keep working in ordinary Markdown notes. LabOS adds structure around them.
- **Two capture modes, one record.** The quick box (automatic time) and a connected Markdown note (free text, pasted screenshots, code) both feed the same evidence. A button or command syncs them. Neither mode is required.
- **LabOS owns time and identity, not the user.** Never ask users to type timestamps or follow a syntax. Time comes from LabOS (insert-entry command, approximate hour, entries stay ordered). Entries are identified by hidden IDs (Obsidian block IDs), never by parsing visible text.
- **Connections must be two-way and survive moves.** A connected note carries its own `labos-id` and session in frontmatter, so it is found by ID, not path. Moving or archiving a note in the vault must not break the link. The note must show which session it belongs to.
- **Explicit, never automatic.** Writing to a note, syncing, and indexing happen on user request (button, command, or opt-in toggle). Nothing runs at startup unless the user enables it in Settings.
- **Compact first, deep on demand.** The main view shows only what is used constantly. Everything else lives in the ☰ menu. Easy for a new user, richer as they learn.
- **Reuse Obsidian.** Prefer native features (frontmatter, block IDs, metadataCache, backlinks, callouts) over custom UI or parsing.
- **Personalization through plain files** (for example a template note), not a plugin system.
- **Do not show fake data.** No placeholder values such as "(unspecified)" or "Not indexed yet". Show nothing or a real fact.
- **Setups repeat.** Starting from the previous setup ("Continue yesterday") must be one click.

## Environment

- Python tests and the CLI run from the repo's `.venv` (Windows: `.venv\Scripts\python.exe -m pytest tests`). The system Python lacks `labos` and `pytest`, so `pytest` there fails with `ModuleNotFoundError: No module named 'labos'`.
- Plugin build and tests: `cd obsidian && npm run build && npm test`.
- Run `git status` before pushing and commit every new source file. An untracked module imported by `view.ts` breaks a fresh clone and CI.

## Phase 0 invariants

1. `labos.db` contains append-only event evidence and transactional session state; `exports/events.jsonl` is a portable derived export.
2. Do not silently edit or reinterpret previous raw events.
3. LabOS must work with no network and no LLM.
4. LabOS must never automatically commit or push Git repositories.
5. File attachment is explicit; do not monitor the whole filesystem.
6. Large-file hashing/copying must remain opt-in.
7. Notes must work even when no session is active.
8. Prefer stdlib and transparent files over services/frameworks.

## Do not add yet

Unless a real Phase 0 failure demonstrates the need, do not add:

- FastAPI or frontend frameworks;
- FTS;
- embeddings/vector databases;
- knowledge graphs/ontologies;
- background agents/Dreams;
- automatic experiment detection;
- instrument discovery;
- multi-user/auth/roles;
- generic plugin systems.

## Change test

Before adding a feature, state which observed problem it solves and how success will be measured.

A feature that does not improve remembering, reproducing, comparing, or transferring experimental work should not be added.

## Engineering expectations

- Keep raw formats documented and migration-friendly.
- Add tests for changes to evidence semantics.
- Keep collectors observational and failure-tolerant.
- Prefer the smallest reversible change.
