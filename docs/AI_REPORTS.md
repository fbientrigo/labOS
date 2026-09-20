# AI advice reports

LabOS reports are **derived outputs**, not raw evidence. The raw event ledger remains the source of truth.

## Pipeline

```text
LabOS evidence
    |
    v
WORKER -> draft JSON
    |
    v
VALIDATOR -> factual/citation audit
    |
    v
CRITIC -> usefulness + missing checks
    |
    v
WORKER -> revised final JSON
    |
    v
Python grounding gate
    |
    +--> report.md
    +--> main.tex
    +--> provenance.json
    +--> overleaf.zip
```

Python removes factual claims and recorded-change claims that do not cite valid event IDs from the selected session. Advice remains explicitly separated from facts and includes a proposed verification step.

## Providers

Each role can independently use:

- `agy`
- `codex`
- `claude`

Defaults:

```text
worker    agy
validator codex
critic    claude
```

The worker is called twice: once for the draft and once after validator/critic feedback.

LabOS uses already-installed and already-authenticated local CLIs. It does not store API keys.

Default command contracts:

```text
agy    -p PROMPT
codex  exec --ephemeral --sandbox read-only --skip-git-repo-check -
claude -p PROMPT --output-format text --permission-mode dontAsk
```

Executable/prefix overrides:

```bash
export LABOS_AGY_CMD="agy"
export LABOS_CODEX_CMD="codex"
export LABOS_CLAUDE_CMD="claude"
```

The values are parsed as argv prefixes and executed without a shell.

## CLI

Generate for the active session; if no session is active, LabOS selects the latest recorded session:

```bash
labos report \
  --output-dir ~/ObsidianVault/LabOS/Reports \
  --worker agy \
  --validator codex \
  --critic claude
```

Or target a session explicitly:

```bash
labos report \
  --session-id ses_abc123 \
  --output-dir ~/ObsidianVault/LabOS/Reports
```

## Obsidian

The plugin exposes:

- **Generate AI report** while a session is active;
- **Generate last AI report** when no session is active.

Configure the three agent roles under **Settings -> LabOS -> AI report**.

The Markdown report is opened in Obsidian when generated. The same report directory contains `overleaf.zip`, which can be uploaded to Overleaf directly.

## Output

Each run creates a session-specific directory:

```text
LabOS/Reports/
  2026-09-20-tgc-ab12cd34/
    evidence.json
    report.md
    main.tex
    provenance.json
    overleaf.zip
```

- `evidence.json`: exact evidence pack sent to the pipeline.
- `report.md`: editable Obsidian report.
- `main.tex`: standalone LaTeX report.
- `provenance.json`: draft, validation, critique, final structured output, and providers.
- `overleaf.zip`: `main.tex` plus editable report/provenance.

## Trust model

- Raw evidence is never rewritten by report generation.
- Notes and artifact metadata are treated as untrusted input, not agent instructions.
- Facts/changes must cite valid event IDs.
- Advice is labeled separately and must include a verification step.
- Reports remain derived and deletable.
