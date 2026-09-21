# Devices and physical identity

LabOS treats the physical device as a durable entry point into experimental evidence.

Phase A adds a small local resource registry plus append-only session transition events. It does not add hardware discovery, QR codes, a hardware ontology, AI fact promotion, or datasheet search.

## Identity

A device has three different identifiers:

- **fingerprint**: a stable identifier already present on the physical unit, such as a manufacturer serial, asset tag, USB/JTAG ID, MAC address, or printed board identifier;
- **alias**: a human-friendly name such as `Zynq #2`;
- **resource_id**: an opaque LabOS identity such as `dev_81f2...`.

The user normally works with the alias or fingerprint. The opaque ID exists so a typo in a fingerprint can be corrected without breaking historical identity.

The registry is stored in:

```text
~/labos-data/resources.json
```

It is mutable current metadata, not raw experimental evidence. Fingerprints are unique. Aliases may repeat; an ambiguous alias lookup fails and requires a fingerprint or resource ID.

## CLI

Register a device:

```bash
labos device add --fingerprint 210308B2A4C7 --alias "Zynq #2" --kind board
```

Inspect the registry:

```bash
labos device list
labos device show "Zynq #2"
labos device show 210308B2A4C7
```

Correct current metadata without changing identity:

```bash
labos device edit "Zynq #2" --fingerprint 210308B2A4D0
labos device edit 210308B2A4D0 --alias "Zynq trigger board"
```

Associate devices with an active session:

```bash
labos device use "Zynq #2"
labos device remove "Zynq #2"
```

## Device context over time

Session device context is evidence, so changes are represented in `events.jsonl`:

```text
RESOURCE_ADD Zynq #2
...
RESOURCE_REMOVE Zynq #2
RESOURCE_ADD Zynq #3
```

Each transition records:

- canonical `resource_id`;
- fingerprint snapshot;
- alias snapshot;
- kind snapshot.

Future event context is derived from these transitions. Past events are never rewritten.

The deterministic Session Record derives a per-event resource context only from the event stream. It deliberately does **not** consult the current mutable registry when hashing historical evidence. Renaming a device later therefore does not silently change an old Session Record or its evidence SHA.

Sessions that predate resources remain valid. Their resource context is simply unrecorded.

## Obsidian device interface

Phase B exposes the resource model as a first-class operational interface in Obsidian:

- **Today** — start/capture work and optionally select devices;
- **Devices** — search physical units, register/correct identity, open a device-specific page;
- **Reports** — generate deterministic/AI-reviewed handoffs separately from capture.

During active work the UI shows the current resource context and supports one-click add/remove plus a keyboard-searchable **Replace** action. Replace emits an explicit `resource_remove` followed by `resource_add`; no past event is edited.

A device page shows:

- current identity;
- whether it is active in the current session;
- evidence from the current session whose derived resource context contains that device;
- quick note / WORKING / BROKEN actions when the device is active;
- explicit empty states for Power and cross-session device state.

A checkpoint is still a session checkpoint. If several resources are active, the event is attributable to all of them according to the recorded context; the UI does not pretend it belongs exclusively to the page currently open.

## What Phase A/B do not know

Phase A identifies physical units and records when they enter or leave a work session. It does not yet store approved electrical facts such as supply voltage, current limit, polarity, or power profiles. Those require explicit human-approved semantics in a later phase.

Datasheet/PDF AI search is deferred to GitHub issue #4.

> **LabOS only knows physical state that was explicitly recorded or approved. Absence of a recorded change is not proof that a physical setting remained unchanged.**
