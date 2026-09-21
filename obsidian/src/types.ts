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
