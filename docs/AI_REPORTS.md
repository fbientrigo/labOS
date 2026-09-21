# LabOS reporting and professional reliability

LabOS treats reporting as a derived layer over immutable experimental evidence. A report is useful only if the underlying evidence remains independently readable and the generation path is auditable.

## Three report modes

### Factual

No AI is required.

```text
events.jsonl
    -> deterministic Session Record
    -> generated.md / report.md / main.tex
```

Use this when external agents are unavailable, inappropriate for the project, or unnecessary.

### Reviewed

```text
Session Record
    -> WORKER
    -> VALIDATOR
    -> deterministic evidence gate
```

This is the default Obsidian mode. It adds a concise handoff and suggested next checks while keeping latency and external calls lower than the rigorous pipeline.

### Rigorous

```text
Session Record
    -> WORKER
    -> VALIDATOR
    -> CRITIC
    -> WORKER revision
    -> FINAL VALIDATOR
    -> deterministic evidence gate
```

Use this for collaborator handoff, difficult debugging sessions, or a report that will be reused later.

## Deterministic Session Record

Every report run first freezes a Session Record containing:

- session identity, project, time range and working directory;
- ordered event timeline;
- WORKING/BROKEN checkpoints;
- Git snapshots at START/END and checkpoints;
- artifact metadata, storage mode and recorded hashes;
- evidence coverage;
- stable human aliases such as `E01`, `E02`;
- the original immutable event IDs.

Generate one directly:

```bash
labos record
labos record --session-id ses_abc123
labos record --json
labos record --output session.md
```

The Session Record is generated without an LLM.

## Evidence coverage

Coverage is descriptive, not a score. LabOS reports whether evidence exists for items it can measure structurally, including:

- START and END;
- observational notes;
- WORKING and BROKEN checkpoints;
- artifacts;
- managed artifact copies;
- artifact SHA-256 hashes;
- Git snapshots at START/END.

An absent item does not imply bad experimental work. It means the corresponding evidence was not recorded in LabOS.

## Evidence identity

The complete deterministic Session Record is canonicalized and hashed:

```text
evidence_sha256 = SHA256(canonical Session Record JSON)
```

Every run stores this hash in:

- `run.json`;
- `provenance.json`;
- `generated.md`;
- the editable `report.md` frontmatter;
- `main.tex`.

This provides a concrete answer to "which evidence was this report generated from?"

## Immutable versioned runs

Generating a report never overwrites an earlier run.

```text
LabOS/Reports/
  2026-09-20-tgc-ab12cd34/
    runs/
      run_20260920T231500123456Z_a1b2c3/
        evidence.json
        session_record.md
        generated.md
        report.md
        main.tex
        provenance.json
        run.json
        progress.json
        overleaf.zip
```

A new invocation creates a new `run_...` directory even when the evidence has not changed.

After completion LabOS marks generated artifacts read-only where the platform permits it. `report.md` intentionally remains writable.

## Generated versus human-edited documents

`generated.md` is the exact generated artifact for the run.

`report.md` starts as a copy of `generated.md` with frontmatter containing:

```yaml
labos_run_id: ...
labos_status: ...
labos_mode: ...
labos_evidence_sha256: ...
labos_generated_sha256: ...
```

Edit `report.md` freely in Obsidian. Do not treat an edited `report.md` as byte-identical to the generated artifact; `generated.md` remains the reference.

## Validation gate

AI output is structured. Summary, facts, changes, advice, open questions and uncertainties must all carry evidence references.

The validator can reject:

- the summary;
- individual facts;
- individual changes;
- individual advice items;
- individual open questions;
- individual uncertainties.

Python then removes rejected or invalidly referenced content before rendering.

For rigorous mode a second validator audits the revised final candidate. A syntactically valid event ID is not enough: validators are explicitly instructed to reject semantic overreach.

## Report status

A run has one of these terminal states:

```text
FACTUAL
VALIDATED
REVIEW_REQUIRED
FAILED
CANCELLED
```

`VALIDATED` means the final AI validator approved the derived content.

`REVIEW_REQUIRED` means a report was produced but the validator did not approve the complete final candidate. The status is rendered prominently.

`FAILED` and `CANCELLED` still preserve the deterministic Session Record and a versioned fallback bundle.

## Provenance

`provenance.json` records:

- LabOS version;
- pipeline version;
- evidence SHA-256;
- report mode and status;
- worker/validator/critic assignments actually used;
- resolved CLI executable;
- CLI version when discoverable;
- explicitly pinned model when available;
- draft;
- validator output;
- critic output;
- revised candidate;
- final validator output;
- deterministic gated output.

Model identity is intentionally recorded as unresolved when the local CLI chooses a hidden/default model. Pin it with:

```bash
export LABOS_AGY_MODEL="..."
export LABOS_CODEX_MODEL="gpt-5.6-sol"
export LABOS_CLAUDE_MODEL="..."
```

The Obsidian settings expose the same optional model pins.

## Doctor and preflight

Run:

```bash
labos doctor
labos doctor --json
labos doctor --provider codex --provider claude
```

Doctor checks:

- LabOS home is writable;
- the cross-process ledger lock can be acquired;
- the event ledger parses cleanly;
- active-session state parses cleanly;
- requested agent executables are resolvable;
- CLI versions when discoverable;
- whether model identity is explicitly pinned.

Report generation also runs agent executable preflight before making external AI calls.

Doctor does not spend model tokens merely to test authentication. Authentication failures therefore still fail the AI stage, while the deterministic Session Record remains available.

## Cross-process safety

Terminal and Obsidian may write to the same LabOS home. Mutating ledger/session operations therefore use a portable exclusive lock file:

```text
~/labos-data/.labos.lock
```

START, END, note append, checkpoints and artifact-event insertion are serialized. Ledger reads also wait for the writer lock, so readers do not intentionally consume a partially written event.

The lock stores PID/host metadata and can recover a dead local owner or an old unresolved lock.

## Progress and cancellation

The Python report command accepts:

```text
--progress-file PATH
--cancel-file PATH
```

Progress is written atomically as structured JSON with stage/current/total/status.

The Obsidian plugin polls this progress file and turns the report button into a cancel action while generation is active. External agent subprocesses poll the cancellation signal and are terminated when cancellation is requested.

A cancelled run is retained as `CANCELLED` rather than deleted.

## CLI

Examples:

```bash
# Always works without AI
labos report \
  --mode factual \
  --output-dir ~/ObsidianVault/LabOS/Reports

# Lower-cost reviewed handoff
labos report \
  --mode reviewed \
  --output-dir ~/ObsidianVault/LabOS/Reports \
  --worker agy \
  --validator codex

# Full gauntlet
labos report \
  --mode rigorous \
  --output-dir ~/ObsidianVault/LabOS/Reports \
  --worker agy \
  --validator codex \
  --critic claude
```

## Trust boundary

The following remain invariants:

- report generation never rewrites `events.jsonl`;
- deterministic evidence works without AI;
- evidence supplied to agents is treated as untrusted data rather than instructions;
- AI is not allowed to silently promote a physical fact into stable truth;
- artifact contents are not automatically sent merely because an artifact event exists;
- failed AI enrichment does not destroy the factual handoff;
- editable human output is distinguishable from immutable generated output.
