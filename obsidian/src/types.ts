export type CheckpointState = "working" | "broken";
export type AgentProvider = "agy" | "codex" | "claude";
export type ReportMode = "factual" | "reviewed" | "rigorous";
export type ReportStatus =
  | "RUNNING"
  | "FACTUAL"
  | "VALIDATED"
  | "REVIEW_REQUIRED"
  | "FAILED"
  | "CANCELLED";

export type DeviceKind = "board" | "scope" | "psu" | "daq" | "detector" | "other";

export interface DeviceResource {
  resource_id: string;
  fingerprint: string;
  alias: string;
  kind: DeviceKind;
  created_at: string;
  updated_at: string;
}

export interface ApprovedFact {
  fact_id: string;
  name: string;
  value: string;
  approved_at: string;
  evidence_refs: string[];
  notes?: string | null;
}

export interface PowerRail {
  label: string;
  voltage: number;
  voltage_unit: string;
  current_limit: number;
  current_unit: string;
  polarity: string;
  typical_draw?: number;
}

export interface PowerProfile {
  profile_id: string;
  name: string;
  rails: PowerRail[];
  approved_at: string;
  evidence_refs: string[];
  notes?: string | null;
}

export interface DeviceKnowledge {
  knowledge_version: number;
  resource_id: string;
  approved_facts: ApprovedFact[];
  power_profiles: PowerProfile[];
}

export interface ResourceSnapshot {
  resource_id: string;
  fingerprint?: string | null;
  alias?: string | null;
  kind?: string | null;
}

export interface LabOSSettings {
  executable: string;
  home: string;
  defaultProject: string;
  defaultWorkdir: string;
  recentLimit: number;
  reportsFolder: string;
  reportMode: ReportMode;
  reportWorker: AgentProvider;
  reportValidator: AgentProvider;
  reportCritic: AgentProvider;
  reportTimeoutSeconds: number;
  agyModel: string;
  codexModel: string;
  claudeModel: string;
}

export interface SessionState {
  schema_version?: number;
  session_id: string;
  project: string;
  label?: string | null;
  started_at: string;
  started_cwd?: string;
}

export interface LabOSEvent {
  schema_version: number;
  id: string;
  timestamp: string;
  type: string;
  session_id: string | null;
  project: string | null;
  cwd: string;
  payload: Record<string, unknown>;
}

export interface CoverageItem {
  id: string;
  label: string;
  state: "present" | "absent" | "not_applicable";
  detail: string;
}

export interface SessionRecord {
  record_version: number;
  session: {
    session_id: string;
    project: string | null;
    label?: string | null;
    workdir?: string | null;
    started_at: string;
    ended_at?: string | null;
    status: "active" | "ended";
  };
  coverage: {
    items: CoverageItem[];
    counts: Record<string, number>;
    absent: string[];
  };
  event_aliases: Record<string, string>;
  allowed_evidence_ids: string[];
  resource_context?: {
    by_event: Record<string, ResourceSnapshot[]>;
    active_at_end: ResourceSnapshot[];
  };
  events: LabOSEvent[];
}

export interface SessionRecordResult {
  evidence_sha256: string;
  record: SessionRecord;
}

export interface AgentProbe {
  provider: string;
  available: boolean;
  version?: string | null;
  model?: string | null;
  model_source?: string;
  resolved_executable?: string | null;
}

export interface DoctorResult {
  labos_version: string;
  home: string;
  core_ok: boolean;
  agents_available: boolean;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  agents: Record<string, AgentProbe>;
  warnings: string[];
}

export interface ReportProgress {
  stage: string;
  message: string;
  current: number;
  total: number;
  run_id?: string | null;
  status: ReportStatus;
  timestamp: string;
}

export interface ReportResult {
  session_id: string;
  run_id: string;
  status: ReportStatus;
  mode: ReportMode;
  evidence_sha256: string;
  report_dir: string;
  session_record: string;
  generated: string;
  report: string;
  markdown: string;
  latex: string;
  overleaf_zip: string;
  provenance: string;
  run_manifest: string;
  providers: Record<string, AgentProvider>;
  error?: string | null;
}

export interface ReportTask {
  promise: Promise<ReportResult>;
  cancel(): Promise<void>;
}

export interface LabOSBackend {
  status(): Promise<SessionState | null>;
  start(project: string, label?: string, workdir?: string): Promise<void>;
  note(text: string): Promise<void>;
  checkpoint(state: CheckpointState, text?: string): Promise<void>;
  attach(path: string, kind: "artifact" | "photo"): Promise<void>;
  end(text?: string): Promise<void>;
  recent(limit: number): Promise<LabOSEvent[]>;
  record(sessionId?: string): Promise<SessionRecordResult>;
  devices(): Promise<DeviceResource[]>;
  addDevice(input: {
    fingerprint: string;
    alias: string;
    kind: DeviceKind;
  }): Promise<DeviceResource>;
  editDevice(
    target: string,
    changes: { fingerprint?: string; alias?: string; kind?: DeviceKind },
  ): Promise<DeviceResource>;
  useDevice(target: string): Promise<void>;
  removeDevice(target: string): Promise<void>;
  deviceKnowledge(target: string): Promise<DeviceKnowledge>;
  approveDeviceFact(
    target: string,
    input: {
      name: string;
      value: string;
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<ApprovedFact>;
  editDeviceFact(
    target: string,
    factId: string,
    input: {
      name: string;
      value: string;
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<ApprovedFact>;
  approvePowerProfile(
    target: string,
    input: {
      name: string;
      rails: PowerRail[];
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<PowerProfile>;
  editPowerProfile(
    target: string,
    profileId: string,
    input: {
      name: string;
      rails: PowerRail[];
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<PowerProfile>;
  doctor(providers?: AgentProvider[]): Promise<DoctorResult>;
  startReport(
    outputDir: string,
    options: {
      sessionId?: string;
      mode: ReportMode;
      worker: AgentProvider;
      validator: AgentProvider;
      critic: AgentProvider;
      timeoutSeconds: number;
    },
    onProgress?: (progress: ReportProgress) => void,
  ): ReportTask;
}
