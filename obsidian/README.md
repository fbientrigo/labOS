# LabOS for Obsidian

A deliberately thin desktop UI over the LabOS CLI.

The plugin does **not** implement a second evidence store. It executes the existing `labos` CLI for writes and reads LabOS' transparent local state for display.

## Features

- right-side LabOS panel with primary **Today / Devices / Reports** navigation;
- device list and device-specific operational pages;
- register/correct device identity from Obsidian without exposing the opaque ID in normal use;
- optional device selection when starting work;
- fast add/remove/replace device actions during an active session;
- start/end work session;
- optional repo/work directory so Git snapshots refer to the experiment rather than the Obsidian process;
- quick notes with Enter;
- WORKING / BROKEN checkpoints;
- attach the current note or another file from the vault;
- current-session / recent timeline;
- current-session evidence filtered by physical device;
- explicit human-approved facts and multi-rail Power Profiles with provenance;
- command to capture selected editor text;
- commands for WORKING / BROKEN;
- configurable LabOS executable, evidence home, default project/workdir, and timeline length;\n- on-demand AI report generation with configurable worker, validator, and critic;\n- editable Markdown, standalone LaTeX, and an Overleaf-ready ZIP.

## Requirements

1. Obsidian desktop.
2. The LabOS Python CLI installed and runnable.
3. Node.js for building the plugin from source.

The plugin is desktop-only in v0 because it uses Node.js to execute the local CLI and read the local evidence ledger. Mobile should use a future backend adapter rather than duplicating LabOS semantics.

## Build

From this directory:

```bash
npm install
npm run build
```

This creates `main.js`.

## Install into a vault

Create:

```text
<Vault>/.obsidian/plugins/labos/
```

and copy into it:

```text
main.js
manifest.json
styles.css
```

Then reload Obsidian, enable **LabOS** under Community plugins, and open it from the ribbon or command palette.

For development, placing/symlinking this directory at `<Vault>/.obsidian/plugins/labos` avoids copying files after every build.

GitHub Actions also publishes those three files together as the `labos-obsidian` build artifact.

## LabOS CLI

From the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

If Obsidian cannot find `labos` because it was launched outside your shell environment, set an absolute executable path in **Settings -> LabOS -> LabOS executable**.

Set **Default work directory** to the repo you most often use, or change the workdir in the Start panel. LabOS stores that directory in the session; later WORKING/BROKEN/END snapshots keep using the same repo even though the commands originate from Obsidian.\n\nUnder **Reports**, choose the default mode. Factual requires no AI; Reviewed uses worker+validator; Rigorous adds critic, revision, and final validation. Advanced settings select providers and optional explicit model pins for provenance. The corresponding local CLIs must already be installed and authenticated for AI modes. See [`../docs/AI_REPORTS.md`](../docs/AI_REPORTS.md).

## Data ownership

The plugin does not rewrite raw evidence. Device writes also call the same CLI as the terminal workflow. Current device identity is read from the transparent `resources.json` registry; session associations remain append-only `resource_add` / `resource_remove` evidence:

```text
Obsidian panel ─┐
                ├─> LabOS CLI ─> events.jsonl / resources.json / device_knowledge.json / artifacts
Terminal ───────┘
```

Removing the plugin does not make LabOS data unreadable or unusable.

## Not in v0

- mobile support;
- HTTP service;
- AI/Dreams;
- semantic search;
- resource ontology;
- automatic filesystem monitoring;
- automatic instrument integration.


## Device interface

The **Devices** page is operational rather than a generic CRUD table. A device page shows its alias, physical fingerprint and kind, whether it is part of the current work, current-session evidence, and quick capture/checkpoint actions when active.

Power settings are shown only when a human-approved Power Profile exists. The device page supports explicit approval/re-approval of multi-rail configurations and approved facts, including evidence references and notes. Cross-session Last Known Working remains intentionally unindexed until Phase D. The UI never infers physical state from absence of changes.

When multiple resources are active, notes and WORKING/BROKEN checkpoints created from a device page still belong to the complete active session resource context.
