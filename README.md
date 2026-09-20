# LabOS

**LabOS is an experimental evidence ledger for electronics and physics lab work.**

The goal is not to create perfect laboratory notebooks. The goal is to make normal work leave enough cheap evidence that future-you can reconstruct:

1. **What state was I in?**
2. **What changed?**
3. **Where is the evidence?**

LabOS is intentionally local-first, filesystem-first, append-only at the raw evidence layer, and usable without an LLM.

## Phase 0: falsify the idea first

Before building a web app, database, embeddings, or autonomous agents, Phase 0 tests one question:

> Do I naturally leave useful evidence while doing real laboratory work?

The core interface is deliberately small and remains available from the terminal:

```bash
labos start tgc --label "Zynq trigger debugging"
labos note "DMA works"
labos attach scope.png --kind photo --copy
labos good "baseline before firmware change"
labos note "loaded new trigger firmware"
labos bad "events disappear after ~70 s"
labos end "continue from DRS4 state tomorrow"
```

`start`, `good`, `bad`, and `end` snapshot the session's working directory when it is a Git repository. By default that directory is where `labos start` was run; interfaces such as the Obsidian plugin can set it explicitly with `--cwd`. LabOS never commits or pushes.

Notes can also be captured without an active session:

```bash
labos note "Zynq #2 left connected to PSU #4"
```

## Data

By default LabOS writes to `~/labos-data`; override it with `LABOS_HOME` or `--home`.

```text
~/labos-data/
├── events.jsonl             # append-only raw evidence
├── artifacts/               # explicit managed copies only
└── .active-session.json     # mutable convenience state
```

`events.jsonl` is the source of truth. Each line is ordinary JSON and remains readable without LabOS.

Artifacts are referenced by absolute path by default. `--copy` explicitly places a copy under `artifacts/`. `--hash` computes SHA-256 when the cost is justified.

## Install for development

```bash
git clone https://github.com/fbientrigo/labOS.git
cd labOS
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```

## Current commands

```text
labos start PROJECT [--label TEXT] [--cwd PATH]
labos note TEXT...
labos good [TEXT...]
labos bad [TEXT...]
labos attach PATH [--kind artifact|photo] [--copy] [--hash] [--note TEXT]
labos end [TEXT...]
labos status
labos recent [-n N]
```

## Obsidian desktop UI

The optional `obsidian/` plugin is a thin UX layer over the same CLI and raw evidence:

```text
Terminal ───────┐
                ├─> LabOS CLI ─> events.jsonl / artifacts
Obsidian panel ─┘
```

It provides Start/End, quick notes, WORKING/BROKEN checkpoints, vault-file attachments, recent timeline, and capture of selected editor text. It does not implement a second evidence store.

Build/install instructions live in [`obsidian/README.md`](obsidian/README.md).

## Design invariants

- Raw evidence is append-only. Derived knowledge must never silently rewrite it.
- Capture must stay faster than opening a conventional ELN entry.
- Physical facts are not promoted to truth by an LLM.
- Large files are not copied unless explicitly requested.
- Git integration is observational only: no automatic commit or push.
- The raw filesystem remains useful independently of LabOS.
- Features must improve remembering, reproducing, comparing, or transferring experiments.

## Explicit non-goals for Phase 0

No FastAPI or standalone web app, SQLite, vector database, embeddings, knowledge graph, ontology, automatic instrument integration, computer vision, experiment-start detection, multi-user architecture, or Dreams.

Those features must earn their place from observed failures in real use.

## 10-day experiment

Use the CLI and/or the thin Obsidian panel during real laboratory work without adding product features. At the end, test whether the captured evidence answers real questions such as:

- Which firmware/commit was working?
- What changed between WORKING and BROKEN?
- Which physical board was involved?
- Where is the scope capture/log/data?
- What had I concluded when I stopped?

If capture is routinely skipped, requires later cleanup, or the decisive information still lives only in memory, reduce or kill the project rather than adding architecture.

See [`docs/PHASE0.md`](docs/PHASE0.md) for the experiment contract.
