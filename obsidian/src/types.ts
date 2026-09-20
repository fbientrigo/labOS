export type CheckpointState = "working" | "broken";
export type AgentProvider = "agy" | "codex" | "claude";

export interface LabOSSettings {
  executable: string;
  home: string;
  defaultProject: string;
  defaultWorkdir: string;
  recentLimit: number;
  reportsFolder: string;
  reportWorker: AgentProvider;
  reportValidator: AgentProvider;
  reportCritic: AgentProvider;
  reportTimeoutSeconds: number;
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

export interface ReportResult {
  session_id: string;
  report_dir: string;
  markdown: string;
  latex: string;
  overleaf_zip: string;
  provenance: string;
  providers: {
    worker: AgentProvider;
    validator: AgentProvider;
    critic: AgentProvider;
  };
}

export interface LabOSBackend {
  status(): Promise<SessionState | null>;
  start(project: string, label?: string, workdir?: string): Promise<void>;
  note(text: string): Promise<void>;
  checkpoint(state: CheckpointState, text?: string): Promise<void>;
  attach(path: string, kind: "artifact" | "photo"): Promise<void>;
  end(text?: string): Promise<void>;
  recent(limit: number): Promise<LabOSEvent[]>;
  report(
    outputDir: string,
    options: {
      sessionId?: string;
      worker: AgentProvider;
      validator: AgentProvider;
      critic: AgentProvider;
      timeoutSeconds: number;
    },
  ): Promise<ReportResult>;
}
