export type CheckpointState = "working" | "broken";

export interface LabOSSettings {
  executable: string;
  home: string;
  defaultProject: string;
  recentLimit: number;
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

export interface LabOSBackend {
  status(): Promise<SessionState | null>;
  start(project: string, label?: string): Promise<void>;
  note(text: string): Promise<void>;
  checkpoint(state: CheckpointState, text?: string): Promise<void>;
  attach(path: string, kind: "artifact" | "photo"): Promise<void>;
  end(text?: string): Promise<void>;
  recent(limit: number): Promise<LabOSEvent[]>;
}
