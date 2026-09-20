# AGENTS.md — LabOS engineering constraints

LabOS is deliberately vulnerable to overengineering. Preserve the experiment before expanding the architecture.

## Product objective

Make normal experimental work leave enough cheap evidence to later reconstruct state, changes, and artifacts.

## Phase 0 invariants

1. `events.jsonl` is append-only raw evidence.
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
- SQLite/FTS;
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
