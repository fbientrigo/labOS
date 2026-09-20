import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";

import type {
  AgentProvider,
  CheckpointState,
  LabOSBackend,
  LabOSEvent,
  LabOSSettings,
  ReportResult,
  SessionState,
} from "./types";

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export class CliLabOSBackend implements LabOSBackend {
  constructor(private readonly settings: LabOSSettings) {}

  private home(): string {
    return expandHome(this.settings.home);
  }

  private run(command: string, args: string[] = []): Promise<string> {
    const cliArgs = ["--home", this.home(), command, ...args];

    return new Promise((resolveRun, rejectRun) => {
      execFile(
        this.settings.executable,
        cliArgs,
        {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim() || stdout.trim() || error.message;
            rejectRun(
              new Error(
                `LabOS CLI failed: ${detail}. Check LabOS and agent CLI settings.`,
              ),
            );
            return;
          }
          resolveRun(stdout.trim());
        },
      );
    });
  }

  async status(): Promise<SessionState | null> {
    try {
      const raw = await readFile(
        join(this.home(), ".active-session.json"),
        "utf8",
      );
      return JSON.parse(raw) as SessionState;
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  }

  async start(
    project: string,
    label?: string,
    workdir?: string,
  ): Promise<void> {
    const args = [project];
    if (label) {
      args.push("--label", label);
    }
    if (workdir) {
      args.push("--cwd", workdir);
    }
    await this.run("start", args);
  }

  async note(text: string): Promise<void> {
    await this.run("note", [text]);
  }

  async checkpoint(state: CheckpointState, text?: string): Promise<void> {
    await this.run(state === "working" ? "good" : "bad", text ? [text] : []);
  }

  async attach(path: string, kind: "artifact" | "photo"): Promise<void> {
    await this.run("attach", [path, "--kind", kind]);
  }

  async end(text?: string): Promise<void> {
    await this.run("end", text ? [text] : []);
  }

  async report(
    outputDir: string,
    options: {
      sessionId?: string;
      worker: AgentProvider;
      validator: AgentProvider;
      critic: AgentProvider;
      timeoutSeconds: number;
    },
  ): Promise<ReportResult> {
    const args = [
      "--output-dir",
      outputDir,
      "--worker",
      options.worker,
      "--validator",
      options.validator,
      "--critic",
      options.critic,
      "--timeout",
      String(options.timeoutSeconds),
    ];
    if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }
    const raw = await this.run("report", args);
    return JSON.parse(raw) as ReportResult;
  }

  async recent(limit: number): Promise<LabOSEvent[]> {
    try {
      const raw = await readFile(join(this.home(), "events.jsonl"), "utf8");
      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const events: LabOSEvent[] = [];

      for (const line of lines.slice(-Math.max(limit, 1))) {
        try {
          events.push(JSON.parse(line) as LabOSEvent);
        } catch {
          // One malformed historical line should not make the capture UI unusable.
        }
      }

      return events;
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  }
}
