import type {
  ApprovedFact,
  DeviceKnowledge,
  PowerProfile,
  PowerRail,
} from "./types";

export interface DeviceKnowledgeActions {
  approveFact(input: {
    name: string;
    value: string;
    evidenceRefs: string[];
    notes?: string;
  }): Promise<void>;
  editFact(
    factId: string,
    input: {
      name: string;
      value: string;
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<void>;
  approvePowerProfile(input: {
    name: string;
    rails: PowerRail[];
    evidenceRefs: string[];
    notes?: string;
  }): Promise<void>;
  editPowerProfile(
    profileId: string,
    input: {
      name: string;
      rails: PowerRail[];
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<void>;
}

function evidenceRefs(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
}

function approvedText(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Approved " + timestamp
    : "Approved " + date.toLocaleString();
}

function renderProvenance(
  container: HTMLElement,
  approvedAt: string,
  refs: string[],
  notes?: string | null,
): void {
  container.createDiv({
    cls: "labos-muted",
    text:
      approvedText(approvedAt) +
      (refs.length ? " · evidence: " + refs.join(", ") : " · no evidence refs"),
  });
  if (notes) {
    container.createDiv({ cls: "labos-muted", text: notes });
  }
}

function renderFactForm(
  container: HTMLElement,
  submitLabel: string,
  initial: ApprovedFact | null,
  submit: (input: {
    name: string;
    value: string;
    evidenceRefs: string[];
    notes?: string;
  }) => Promise<void>,
): void {
  const form = container.createDiv({ cls: "labos-stack" });
  const name = form.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Fact name, e.g. FPGA" },
  });
  const value = form.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Approved value" },
  });
  const refs = form.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Evidence refs, comma separated" },
  });
  const notes = form.createEl("textarea", {
    cls: "labos-textarea",
    attr: { placeholder: "Notes (optional)" },
  });

  if (initial) {
    name.value = initial.name;
    value.value = initial.value;
    refs.value = initial.evidence_refs.join(", ");
    notes.value = initial.notes ?? "";
  }

  const button = form.createEl("button", { text: submitLabel });
  button.addEventListener("click", () => {
    const nameValue = name.value.trim();
    const factValue = value.value.trim();
    if (!nameValue || !factValue) {
      return;
    }
    void submit({
      name: nameValue,
      value: factValue,
      evidenceRefs: evidenceRefs(refs.value),
      notes: notes.value.trim() || undefined,
    });
  });
}

function renderFacts(
  container: HTMLElement,
  facts: ApprovedFact[],
  actions: DeviceKnowledgeActions,
): void {
  const block = container.createDiv({ cls: "labos-device-panel" });
  block.createEl("strong", { text: "APPROVED FACTS" });

  if (facts.length === 0) {
    block.createDiv({ cls: "labos-empty-value", text: "None approved" });
  } else {
    for (const fact of facts) {
      const row = block.createDiv({ cls: "labos-approved-item" });
      row.createDiv({
        cls: "labos-approved-value",
        text: fact.name + " · " + fact.value,
      });
      renderProvenance(
        row,
        fact.approved_at,
        fact.evidence_refs,
        fact.notes,
      );

      const edit = row.createEl("details", { cls: "labos-device-form" });
      edit.createEl("summary", { text: "Edit / re-approve" });
      renderFactForm(edit, "Re-approve fact", fact, (input) =>
        actions.editFact(fact.fact_id, input),
      );
    }
  }

  const add = block.createEl("details", { cls: "labos-device-form" });
  add.createEl("summary", { text: "Approve fact" });
  renderFactForm(add, "Approve fact", null, actions.approveFact);
}

interface RailInputs {
  root: HTMLElement;
  label: HTMLInputElement;
  voltage: HTMLInputElement;
  voltageUnit: HTMLInputElement;
  currentLimit: HTMLInputElement;
  currentUnit: HTMLInputElement;
  polarity: HTMLInputElement;
  typicalDraw: HTMLInputElement;
}

function makeRailInputs(
  container: HTMLElement,
  initial?: PowerRail,
): RailInputs {
  const root = container.createDiv({ cls: "labos-power-rail-form" });
  const label = root.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Rail label" },
  });
  const voltage = root.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Voltage", inputmode: "decimal" },
  });
  const voltageUnit = root.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Voltage unit", value: "V" },
  });
  const currentLimit = root.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Current limit", inputmode: "decimal" },
  });
  const currentUnit = root.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Current unit", value: "A" },
  });
  const polarity = root.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Polarity" },
  });
  const typicalDraw = root.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Typical draw (optional)", inputmode: "decimal" },
  });

  if (initial) {
    label.value = initial.label;
    voltage.value = String(initial.voltage);
    voltageUnit.value = initial.voltage_unit;
    currentLimit.value = String(initial.current_limit);
    currentUnit.value = initial.current_unit;
    polarity.value = initial.polarity;
    typicalDraw.value =
      initial.typical_draw === undefined ? "" : String(initial.typical_draw);
  }

  return {
    root,
    label,
    voltage,
    voltageUnit,
    currentLimit,
    currentUnit,
    polarity,
    typicalDraw,
  };
}

function numberInput(input: HTMLInputElement): number {
  const raw = input.value.trim();
  return raw ? Number(raw) : Number.NaN;
}

function readRail(inputs: RailInputs): PowerRail {
  const rail: PowerRail = {
    label: inputs.label.value.trim(),
    voltage: numberInput(inputs.voltage),
    voltage_unit: inputs.voltageUnit.value.trim(),
    current_limit: numberInput(inputs.currentLimit),
    current_unit: inputs.currentUnit.value.trim(),
    polarity: inputs.polarity.value.trim(),
  };
  if (inputs.typicalDraw.value.trim()) {
    rail.typical_draw = numberInput(inputs.typicalDraw);
  }
  return rail;
}

function renderPowerForm(
  container: HTMLElement,
  submitLabel: string,
  initial: PowerProfile | null,
  submit: (input: {
    name: string;
    rails: PowerRail[];
    evidenceRefs: string[];
    notes?: string;
  }) => Promise<void>,
): void {
  const form = container.createDiv({ cls: "labos-stack" });
  const name = form.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Profile name, e.g. Bench nominal" },
  });
  const railsRoot = form.createDiv({ cls: "labos-stack" });
  const railInputs: RailInputs[] = [];

  const addRail = (rail?: PowerRail): void => {
    const inputs = makeRailInputs(railsRoot, rail);
    railInputs.push(inputs);
    if (railInputs.length > 1) {
      const remove = inputs.root.createEl("button", { text: "Remove rail" });
      remove.addEventListener("click", () => {
        inputs.root.remove();
        const index = railInputs.indexOf(inputs);
        if (index >= 0) {
          railInputs.splice(index, 1);
        }
      });
    }
  };

  if (initial) {
    name.value = initial.name;
    for (const rail of initial.rails) {
      addRail(rail);
    }
  } else {
    addRail();
  }

  const addRailButton = form.createEl("button", { text: "+ Add rail" });
  addRailButton.addEventListener("click", () => addRail());

  const refs = form.createEl("input", {
    cls: "labos-input",
    attr: { placeholder: "Evidence refs, comma separated" },
  });
  const notes = form.createEl("textarea", {
    cls: "labos-textarea",
    attr: { placeholder: "Notes (optional)" },
  });
  if (initial) {
    refs.value = initial.evidence_refs.join(", ");
    notes.value = initial.notes ?? "";
  }

  const button = form.createEl("button", { text: submitLabel });
  button.addEventListener("click", () => {
    const nameValue = name.value.trim();
    if (!nameValue || railInputs.length === 0) {
      return;
    }
    void submit({
      name: nameValue,
      rails: railInputs.map(readRail),
      evidenceRefs: evidenceRefs(refs.value),
      notes: notes.value.trim() || undefined,
    });
  });
}

function railText(rail: PowerRail): string {
  const typical =
    rail.typical_draw === undefined
      ? ""
      : " · typical " + String(rail.typical_draw) + " " + rail.current_unit;
  return (
    rail.label +
    ": " +
    String(rail.voltage) +
    " " +
    rail.voltage_unit +
    " · limit " +
    String(rail.current_limit) +
    " " +
    rail.current_unit +
    " · " +
    rail.polarity +
    typical
  );
}

function renderPowerProfiles(
  container: HTMLElement,
  profiles: PowerProfile[],
  actions: DeviceKnowledgeActions,
): void {
  const block = container.createDiv({ cls: "labos-device-panel" });
  block.createEl("strong", { text: "POWER" });

  if (profiles.length === 0) {
    block.createDiv({ cls: "labos-empty-value", text: "Not recorded" });
    block.createDiv({
      cls: "labos-muted",
      text:
        "No approved voltage, current limit, polarity, or Power Profile is stored yet.",
    });
  } else {
    for (const profile of profiles) {
      const card = block.createDiv({ cls: "labos-approved-item" });
      card.createDiv({ cls: "labos-approved-value", text: profile.name });
      for (const rail of profile.rails) {
        card.createDiv({ text: railText(rail) });
      }
      renderProvenance(
        card,
        profile.approved_at,
        profile.evidence_refs,
        profile.notes,
      );

      const edit = card.createEl("details", { cls: "labos-device-form" });
      edit.createEl("summary", { text: "Update configuration" });
      renderPowerForm(edit, "Re-approve profile", profile, (input) =>
        actions.editPowerProfile(profile.profile_id, input),
      );
    }
  }

  const add = block.createEl("details", { cls: "labos-device-form" });
  add.createEl("summary", { text: "Approve Power Profile" });
  renderPowerForm(add, "Approve profile", null, actions.approvePowerProfile);
}

export function renderDeviceKnowledge(
  container: HTMLElement,
  knowledge: DeviceKnowledge | null,
  error: string | null,
  actions: DeviceKnowledgeActions,
): void {
  if (error) {
    const block = container.createDiv({ cls: "labos-device-panel" });
    block.createEl("strong", { text: "APPROVED CONFIGURATION" });
    block.createDiv({
      cls: "labos-warning",
      text:
        "Approved device knowledge is unavailable. Evidence capture is unaffected. " +
        error,
    });
    return;
  }

  const current: DeviceKnowledge = knowledge ?? {
    knowledge_version: 1,
    resource_id: "",
    approved_facts: [],
    power_profiles: [],
  };
  renderPowerProfiles(container, current.power_profiles, actions);
  renderFacts(container, current.approved_facts, actions);
}
