import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { readFile, unlink, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

import type {
  AgentProvider,
  ApprovedFact,
  CheckpointState,
  DeviceKind,
  DeviceKnowledge,
  DeviceResource,
  DoctorResult,
  LabOSBackend,
  LabOSEvent,
  LabOSSettings,
  ReportProgress,
  ReportResult,
  PowerProfile,
  PowerRail,
  ReportTask,
  SessionRecordResult,
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

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const models: Array<[string, string]> = [
      ["LABOS_AGY_MODEL", this.settings.agyModel],
      ["LABOS_CODEX_MODEL", this.settings.codexModel],
      ["LABOS_CLAUDE_MODEL", this.settings.claudeModel],
    ];
    for (const [key, value] of models) {
      if (value.trim()) {
        env[key] = value.trim();
      } else {
        delete env[key];
      }
    }
    return env;
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
          env: this.childEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim() || stdout.trim() || error.message;
            rejectRun(
              new Error(
                `LabOS CLI failed: ${detail}. Check LabOS and local agent setup.`,
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

  async record(sessionId?: string): Promise<SessionRecordResult> {
    const args = ["--json"];
    if (sessionId) {
      args.push("--session-id", sessionId);
    }
    return JSON.parse(await this.run("record", args)) as SessionRecordResult;
  }

  async devices(): Promise<DeviceResource[]> {
    try {
      const raw = await readFile(join(this.home(), "resources.json"), "utf8");
      const parsed = JSON.parse(raw) as { resources?: unknown };
      if (!Array.isArray(parsed.resources)) {
        throw new Error("Malformed LabOS resource registry: expected resources list.");
      }
      return parsed.resources
        .filter((item): item is DeviceResource => {
          if (!item || typeof item !== "object") {
            return false;
          }
          const resource = item as Record<string, unknown>;
          return (
            typeof resource.resource_id === "string" &&
            typeof resource.fingerprint === "string" &&
            typeof resource.alias === "string" &&
            typeof resource.kind === "string" &&
            typeof resource.created_at === "string" &&
            typeof resource.updated_at === "string"
          );
        })
        .sort((a, b) => {
          const byAlias = a.alias.localeCompare(b.alias, undefined, {
            sensitivity: "base",
          });
          return byAlias || a.fingerprint.localeCompare(b.fingerprint);
        });
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  async addDevice(input: {
    fingerprint: string;
    alias: string;
    kind: DeviceKind;
  }): Promise<DeviceResource> {
    const raw = await this.run("device", [
      "add",
      "--fingerprint",
      input.fingerprint,
      "--alias",
      input.alias,
      "--kind",
      input.kind,
    ]);
    return JSON.parse(raw) as DeviceResource;
  }

  async editDevice(
    target: string,
    changes: { fingerprint?: string; alias?: string; kind?: DeviceKind },
  ): Promise<DeviceResource> {
    const args = ["edit", target];
    if (changes.fingerprint !== undefined) {
      args.push("--fingerprint", changes.fingerprint);
    }
    if (changes.alias !== undefined) {
      args.push("--alias", changes.alias);
    }
    if (changes.kind !== undefined) {
      args.push("--kind", changes.kind);
    }
    return JSON.parse(await this.run("device", args)) as DeviceResource;
  }

  async useDevice(target: string): Promise<void> {
    await this.run("device", ["use", target]);
  }

  async removeDevice(target: string): Promise<void> {
    await this.run("device", ["remove", target]);
  }

  async deviceKnowledge(target: string): Promise<DeviceKnowledge> {
    return JSON.parse(
      await this.run("device", ["knowledge", target]),
    ) as DeviceKnowledge;
  }

  async approveDeviceFact(
    target: string,
    input: {
      name: string;
      value: string;
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<ApprovedFact> {
    const args = [
      "fact",
      "approve",
      target,
      "--name",
      input.name,
      "--value",
      input.value,
    ];
    for (const ref of input.evidenceRefs) {
      args.push("--evidence", ref);
    }
    if (input.notes) {
      args.push("--notes", input.notes);
    }
    return JSON.parse(await this.run("device", args)) as ApprovedFact;
  }

  async editDeviceFact(
    target: string,
    factId: string,
    input: {
      name: string;
      value: string;
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<ApprovedFact> {
    const args = [
      "fact",
      "edit",
      target,
      factId,
      "--name",
      input.name,
      "--value",
      input.value,
    ];
    for (const ref of input.evidenceRefs) {
      args.push("--evidence", ref);
    }
    if (input.notes) {
      args.push("--notes", input.notes);
    }
    return JSON.parse(await this.run("device", args)) as ApprovedFact;
  }

  async approvePowerProfile(
    target: string,
    input: {
      name: string;
      rails: PowerRail[];
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<PowerProfile> {
    const args = [
      "power",
      "approve",
      target,
      "--name",
      input.name,
      "--rails-json",
      JSON.stringify(input.rails),
    ];
    for (const ref of input.evidenceRefs) {
      args.push("--evidence", ref);
    }
    if (input.notes) {
      args.push("--notes", input.notes);
    }
    return JSON.parse(await this.run("device", args)) as PowerProfile;
  }

  async editPowerProfile(
    target: string,
    profileId: string,
    input: {
      name: string;
      rails: PowerRail[];
      evidenceRefs: string[];
      notes?: string;
    },
  ): Promise<PowerProfile> {
    const args = [
      "power",
      "edit",
      target,
      profileId,
      "--name",
      input.name,
      "--rails-json",
      JSON.stringify(input.rails),
    ];
    for (const ref of input.evidenceRefs) {
      args.push("--evidence", ref);
    }
    if (input.notes) {
      args.push("--notes", input.notes);
    }
    return JSON.parse(await this.run("device", args)) as PowerProfile;
  }

  async doctor(providers?: AgentProvider[]): Promise<DoctorResult> {
    const args = ["--json"];
    for (const provider of providers ?? []) {
      args.push("--provider", provider);
    }
    return JSON.parse(await this.run("doctor", args)) as DoctorResult;
  }

  startReport(
    outputDir: string,
    options: {
      sessionId?: string;
      mode: "factual" | "reviewed" | "rigorous";
      worker: AgentProvider;
      validator: AgentProvider;
      critic: AgentProvider;
      timeoutSeconds: number;
    },
    onProgress?: (progress: ReportProgress) => void,
  ): ReportTask {
    const token = randomUUID();
    const progressPath = join(tmpdir(), `labos-report-${token}.progress.json`);
    const cancelPath = join(tmpdir(), `labos-report-${token}.cancel`);
    const args = [
      "--home",
      this.home(),
      "report",
      "--output-dir",
      outputDir,
      "--mode",
      options.mode,
      "--worker",
      options.worker,
      "--validator",
      options.validator,
      "--critic",
      options.critic,
      "--timeout",
      String(options.timeoutSeconds),
      "--progress-file",
      progressPath,
      "--cancel-file",
      cancelPath,
    ];
    if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    let cancelled = false;
    let lastProgress = "";
    let pollHandle: ReturnType<typeof setInterval> | null = null;

    const cleanup = async (): Promise<void> => {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      await Promise.all([
        unlink(progressPath).catch(() => undefined),
        unlink(cancelPath).catch(() => undefined),
      ]);
    };

    const poll = (): void => {
      void readFile(progressPath, "utf8")
        .then((raw) => {
          if (raw === lastProgress) {
            return;
          }
          lastProgress = raw;
          onProgress?.(JSON.parse(raw) as ReportProgress);
        })
        .catch(() => undefined);
    };

    const promise = new Promise<ReportResult>((resolveReport, rejectReport) => {
      pollHandle = setInterval(poll, 250);
      const child = execFile(
        this.settings.executable,
        args,
        {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: this.childEnv(),
        },
        (error, stdout, stderr) => {
          poll();
          void cleanup().then(() => {
            if (error) {
              const detail = stderr.trim() || stdout.trim() || error.message;
              rejectReport(
                new Error(
                  cancelled
                    ? "Report cancellation did not complete cleanly."
                    : `LabOS report failed: ${detail}`,
                ),
              );
              return;
            }
            try {
              resolveReport(JSON.parse(stdout.trim()) as ReportResult);
            } catch (parseError) {
              rejectReport(
                new Error(
                  `LabOS returned an invalid report result: ${String(parseError)}`,
                ),
              );
            }
          });
        },
      );

      child.on("error", (error) => {
        void cleanup();
        rejectReport(error);
      });
    });

    return {
      promise,
      cancel: async () => {
        cancelled = true;
        await writeFile(cancelPath, "cancel\n", "utf8");
      },
    };
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
          // Core reads fail closed; this display helper ignores a single malformed
          // historical line so the panel can still surface the Doctor action.
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
