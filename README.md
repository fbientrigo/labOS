<p align="center">
  <img src="assets/labos-banner.svg" alt="LabOS — Experiments Remember" width="100%">
</p>

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
├── labos.db                 # authoritative event history and session state
├── resources.json           # mutable current device identity registry
├── device_knowledge.json    # explicit human-approved facts / Power Profiles
├── artifacts/               # explicit managed copies only
└── exports/
    └── events.jsonl         # deterministic portable export (on demand)
```

`labos.db` is the operational source of truth. Session transitions and their events commit together. Run `labos export` to make a portable JSONL snapshot; it is never read as live state. Stop older LabOS processes before upgrading. A legacy root `events.jsonl` is validated and imported automatically on first use, then preserved unchanged. If it is malformed or contradicts `.active-session.json`, LabOS refuses migration and leaves the original files alone. Inspect contradictory evidence before moving any stale state file aside and retrying. Once the database exists, legacy files are ignored.

SQLite uses WAL, `synchronous=FULL`, foreign keys and a five-second busy timeout. Keep the database on a local disk: [SQLite WAL does not support network filesystems](https://sqlite.org/wal.html). Back up the database with SQLite's backup API (or while LabOS is closed), because an active database can include `labos.db-wal`. The existing device registry and approved-fact files remain separate JSON files; the SQLite transaction covers sessions and their events.

For an invalid legacy file, `labos doctor` reports the error and refuses import. To recover explicitly, first preserve its exact bytes under another filename such as `events.damaged.jsonl`, then make a separately reviewed `events.jsonl` containing only complete, verified events. Do not invent a missing START or END. Retry `labos doctor` only when that reviewed file is ready. The importer never performs this repair automatically.

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
labos recent [-n N] --json
labos export [PATH]
labos device add --fingerprint ID --alias NAME [--kind board|scope|psu|daq|detector|other]
labos device list
labos device show TARGET
labos device edit TARGET [--fingerprint ID] [--alias NAME] [--kind KIND]
labos device use TARGET
labos device remove TARGET
labos device knowledge TARGET
labos device fact approve TARGET --name NAME --value VALUE [--evidence REF ...] [--notes TEXT]
labos device fact edit TARGET FACT_ID --name NAME --value VALUE [--evidence REF ...] [--notes TEXT]
labos device power approve TARGET --name NAME --rails-json JSON [--evidence REF ...] [--notes TEXT]
labos device power edit TARGET PROFILE_ID --name NAME --rails-json JSON [--evidence REF ...] [--notes TEXT]
```

## Obsidian desktop UI

The optional `obsidian/` plugin is a thin UX layer over the same CLI and raw evidence:

```text
Terminal ───────┐
                ├─> LabOS CLI ─> labos.db / artifacts
Obsidian panel ─┘
```

It provides primary **Today / Devices / Reports** navigation, device-specific operational pages, optional device selection at session start, fast device add/remove/replace transitions, Start/End, quick notes, WORKING/BROKEN checkpoints, vault-file attachments, recent timeline, evidence coverage, setup preflight, and versioned Factual/Reviewed/Rigorous handoffs with live progress and cancellation. Reports are derived outputs; they do not implement a second evidence store.

Build/install instructions live in [`obsidian/README.md`](obsidian/README.md). The professional reporting/reliability contract is documented in [`docs/AI_REPORTS.md`](docs/AI_REPORTS.md). Physical device identity and session resource context are documented in [`docs/DEVICES.md`](docs/DEVICES.md).

## Design invariants

- Database event evidence is append-only. Derived knowledge must never silently rewrite it.
- Capture must stay faster than opening a conventional ELN entry.
- Physical facts are not promoted to truth by an LLM.
- Large files are not copied unless explicitly requested.
- Git integration is observational only: no automatic commit or push.
- The raw filesystem remains useful independently of LabOS.
- Features must improve remembering, reproducing, comparing, or transferring experiments.

## Explicit non-goals for Phase 0

No FastAPI or standalone web app, SQLite, vector database, embeddings, knowledge graph, ontology, automatic instrument integration, computer vision, experiment-start detection, multi-user architecture, or autonomous/background Dreams. AI remains explicit and optional: deterministic Session Records and factual reports require no model.

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
