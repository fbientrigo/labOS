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
  DevicePort,
  DevicePortInput,
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
  SetupSnapshot,
  SetupHistoryItem,
  SessionChoice,
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
    const raw = await this.run("status");
    return raw === "No active session." ? null : JSON.parse(raw) as SessionState;
  }

  async start(
      project: string,
      label?: string,
      workdir?: string,
      setup?: SetupSnapshot,
    ): Promise<void> {
      const args = [project];
    if (label) {
      args.push("--label", label);
    }
      if (workdir) {
        args.push("--cwd", workdir);
      }
      if (setup) args.push("--setup-json", JSON.stringify(setup));
      await this.run("start", args);
  }

  async note(text: string): Promise<void> {
    await this.run("note", [text]);
  }

  async checkpoint(state: CheckpointState, text?: string, options: { tag?: string; occurredAt?: string; links?: Array<{ title: string; path?: string; kind?: string }>; setup?: SetupSnapshot; sessionId?: string } = {}): Promise<LabOSEvent> {
    const args = [...(text ? [text] : [])];
    if (options.tag) args.push("--tag", options.tag);
    if (options.occurredAt) args.push("--at", options.occurredAt);
    if (options.links?.length) args.push("--links-json", JSON.stringify(options.links));
    if (options.setup) args.push("--setup-json", JSON.stringify(options.setup));
    if (options.sessionId) args.push("--session-id", options.sessionId);
    args.push("--json");
    return JSON.parse(await this.run(state === "working" ? "good" : "bad", args)) as LabOSEvent;
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

  private portArgs(input: DevicePortInput): string[] {
    const args = ["--label", input.label, "--kind", input.kind, "--direction", input.direction];
    if (input.connector) args.push("--connector", input.connector);
    if (input.notes) args.push("--notes", input.notes);
    return args;
  }

  async addDevicePort(target: string, input: DevicePortInput): Promise<DevicePort> {
    return JSON.parse(await this.run("device", ["port", "add", target, ...this.portArgs(input)])) as DevicePort;
  }

  async editDevicePort(target: string, portId: string, input: DevicePortInput): Promise<DevicePort> {
    return JSON.parse(await this.run("device", ["port", "edit", target, portId, ...this.portArgs(input)])) as DevicePort;
  }

  async removeDevicePort(target: string, portId: string): Promise<void> {
    await this.run("device", ["port", "remove", target, portId]);
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
    return JSON.parse(await this.run("recent", ["-n", String(limit), "--json"])) as LabOSEvent[];
  }

  async setup(): Promise<SetupSnapshot> {
    return JSON.parse(await this.run("setup", ["get"])) as SetupSnapshot;
  }

  async saveSetup(value: SetupSnapshot, baseEventId?: string): Promise<void> {
    const args = ["set", "--json", JSON.stringify(value)];
    if (baseEventId !== undefined) args.push("--base-event-id", baseEventId);
    await this.run("setup", args);
  }

  async capture(input: { text: string; kind?: "note" | "measurement"; tag?: string; occurredAt?: string; target?: string; current?: number; unit?: "A" | "mA"; voltage?: number; links?: Array<{ title: string; path?: string; kind?: string }>; sessionId?: string; setup?: SetupSnapshot }): Promise<LabOSEvent> {
    const args = ["--kind", input.kind ?? "note"];
    if (input.tag) args.push("--tag", input.tag);
    if (input.occurredAt) args.push("--at", input.occurredAt);
    if (input.target) args.push("--target", input.target);
    if (input.current !== undefined) args.push("--current", String(input.current));
    if (input.unit) args.push("--unit", input.unit);
    if (input.voltage !== undefined) args.push("--voltage", String(input.voltage));
    if (input.links?.length) args.push("--links-json", JSON.stringify(input.links));
    if (input.sessionId) args.push("--session-id", input.sessionId);
    if (input.setup) args.push("--setup-json", JSON.stringify(input.setup));
    if (input.text) args.push(input.text);
    return JSON.parse(await this.run("capture", args)) as LabOSEvent;
  }

  async day(day: string, options: { sessionId?: string; tag?: string; search?: string; offset?: number; limit?: number } = {}): Promise<LabOSEvent[]> {
    const args = [day, "--offset", String(options.offset ?? 0), "--limit", String(options.limit ?? 100)];
    if (options.sessionId) args.push("--session-id", options.sessionId);
    if (options.tag) args.push("--tag", options.tag);
    if (options.search) args.push("--search", options.search);
    return JSON.parse(await this.run("log", args)) as LabOSEvent[];
  }

  async revise(entryId: string, changes: Record<string, unknown>): Promise<void> {
    await this.run("revise", [entryId, "--changes-json", JSON.stringify(changes)]);
  }

  async assetRename(oldPath: string, newPath: string): Promise<void> {
    await this.run("asset", ["rename", oldPath, newPath]);
  }

  async tags(day: string): Promise<Array<{ name: string; color: string }>> {
    return JSON.parse(await this.run("tag", ["list", day])) as Array<{ name: string; color: string }>;
  }

  async setTag(day: string, name: string, color: string): Promise<void> {
    await this.run("tag", ["set", day, name, color]);
  }

  async retag(day: string, oldTag: string, newTag: string): Promise<void> {
    await this.run("tag", ["retag", day, oldTag, newTag]);
  }

  async setupHistory(): Promise<SetupHistoryItem[]> {
    return JSON.parse(await this.run("setup", ["history"])) as SetupHistoryItem[];
  }

  async sessions(): Promise<SessionChoice[]> {
    return JSON.parse(await this.run("sessions")) as SessionChoice[];
  }

  async syncMarkdown(path: string, apply = false, removeIds: string[] = []): Promise<Awaited<ReturnType<LabOSBackend["syncMarkdown"]>>> {
    const args = [path];
    if (apply) args.push("--apply");
    for (const id of removeIds) args.push("--remove-id", id);
    return JSON.parse(await this.run("sync-log", args)) as Awaited<ReturnType<LabOSBackend["syncMarkdown"]>>;
  }

  async writeDailyLog(day: string, path: string): Promise<void> {
    await this.run("markdown", [day, path]);
  }

  async dailyLogId(day: string): Promise<string> {
    return (await this.run("log-id", [day])).trim();
  }

  async assetMap(): Promise<Record<string, string>> {
    return JSON.parse(await this.run("asset-map")) as Record<string, string>;
  }
}
