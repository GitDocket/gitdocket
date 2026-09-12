/** Opt-in local observations. Kept on a Bun-only subpath, separate from cache. */
import { Database } from "bun:sqlite";
import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { z } from "zod";
import { DOCKET_VERSION } from "./version";
import { newWorkCounts, workCounts } from "./work-metrics";

export const OPERATIONS = [
  "overview",
  "ready",
  "task_list",
  "task_get",
  "task_create",
  "task_start",
  "task_stop",
  "task_close",
  "task_edit",
  "set_status",
  "set_priority",
  "set_rank",
  "set_epic",
  "append_log",
  "search",
  "source_page",
  "lint",
  "index",
  "verify",
  "init",
  "upgrade",
  "freshness",
  "board",
  "epics",
  "docs",
  "activity",
  "config",
  "commit",
] as const;
export type Operation = (typeof OPERATIONS)[number];
const count = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[a-f0-9-]{32,64}$/);
const state = z.enum(["unknown", "uninitialized", "metadata", "search"]);
export const dimensionsSchema = z.object({
  indexState: state.default("unknown"),
  concepts: count.nullable().default(null),
  sourceBytes: count.nullable().default(null),
  generation: count.nullable().default(null),
});
export type Dimensions = z.infer<typeof dimensionsSchema>;
const common = {
  schema: z.literal(1),
  id,
  time: count,
  project: id,
  runtime: id,
  uptimeMs: count,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  surface: z.enum(["cli", "mcp", "serve"]),
};
export const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("operation"),
    operation: z.enum(OPERATIONS),
    durationMs: count,
    outcome: z.enum(["success", "error"]),
    error: z.enum([
      "none",
      "validation",
      "not_found",
      "conflict",
      "permission",
      "interrupted",
      "internal",
      "unknown",
    ]),
    trigger: z.enum(["explicit", "background", "unknown"]),
    actor: z.enum(["human", "agent", "unknown"]),
    host: z.enum(["codex", "claude", "other", "unknown"]),
    workflow: id.nullable(),
    before: dimensionsSchema,
    after: dimensionsSchema,
    work: z
      .object({
        parse: count,
        readyRow: count,
        dependencyEdge: count,
        searchDocument: count,
      })
      .nullable()
      .default(null),
    dropped: count,
  }),
  z.object({
    ...common,
    kind: z.literal("runtime"),
    rss: count,
    dimensions: dimensionsSchema,
  }),
]);
export type UsageEvent = z.infer<typeof eventSchema>;
export type OperationEvent = Extract<UsageEvent, { kind: "operation" }>;
export const limitsSchema = z.object({
  operationLimit: z.number().int().min(1).max(10000).default(10000),
  runtimeLimit: z.number().int().min(1).max(1000).default(1000),
  operationDays: z.number().int().min(1).max(30).default(30),
  runtimeDays: z.number().int().min(1).max(7).default(7),
  sampleIntervalMs: z.number().int().min(60000).max(86400000).default(60000),
});
export type Limits = z.infer<typeof limitsSchema>;
const hash = (secret: string, value: string) =>
  createHmac("sha256", secret).update(value).digest("hex");

// Resolve the existing ancestor too: a symlink cannot redirect storage into a repo.
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), basename(path));
}
export function telemetryDirectory(): string {
  return resolve(
    process.env.DOCKET_TELEMETRY_DIR ??
      join(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
        "gitdocket",
        "telemetry",
      ),
  );
}
interface Enrollment {
  project: string;
  enabled: number;
  since: number;
}

export class TelemetryStore {
  readonly directory: string;
  readonly root: string;
  constructor(root: string, directory = telemetryDirectory()) {
    this.root = canonical(resolve(root));
    this.directory = canonical(resolve(directory));
    const rel = relative(this.root, this.directory);
    if (
      !rel ||
      (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        rel !== ".." &&
        !isAbsolute(rel))
    )
      throw new Error("telemetry storage must be outside the project");
  }
  private open(create = false, readonly = false): Database | undefined {
    const path = join(this.directory, "usage.sqlite");
    if (!create && !existsSync(path)) return;
    if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const db = new Database(path, { create, readonly, strict: true });
    try {
      if (readonly) {
        db.exec("PRAGMA busy_timeout=0;");
        return db;
      }
      db.exec(
        "PRAGMA busy_timeout=0; PRAGMA max_page_count=8192; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=128;",
      );
      if (create) {
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=128;
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, project TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL, since INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, time INTEGER NOT NULL, project TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS events_retention ON events(kind,time);
          CREATE INDEX IF NOT EXISTS events_project ON events(project,time);`);
        db.query("INSERT OR IGNORE INTO settings VALUES ('secret', ?)").run(
          randomUUID(),
        );
        db.query("INSERT OR IGNORE INTO settings VALUES ('limits', ?)").run(
          JSON.stringify(limitsSchema.parse({})),
        );
        chmodSync(path, 0o600);
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private secret(db: Database): string {
    const row = db
      .query("SELECT value FROM settings WHERE key='secret'")
      .get() as { value: string } | null;
    if (!row) throw new Error("unsupported telemetry store");
    return row.value;
  }
  private enrollment(db: Database): Enrollment | null {
    return db
      .query("SELECT project,enabled,since FROM projects WHERE key=?")
      .get(hash(this.secret(db), this.root)) as Enrollment | null;
  }
  private limits(db: Database): Limits {
    const row = db
      .query("SELECT value FROM settings WHERE key='limits'")
      .get() as { value: string };
    return limitsSchema.parse(JSON.parse(row.value));
  }
  private prune(db: Database, now: number, limits = this.limits(db)) {
    for (const kind of ["operation", "runtime"] as const) {
      const days =
        kind === "operation" ? limits.operationDays : limits.runtimeDays;
      const limit =
        kind === "operation" ? limits.operationLimit : limits.runtimeLimit;
      db.query("DELETE FROM events WHERE kind=? AND time<?").run(
        kind,
        now - days * 86400000,
      );
      db.query(
        "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE kind=? ORDER BY time DESC, id DESC LIMIT -1 OFFSET ?)",
      ).run(kind, limit);
    }
  }
  enable(options: Partial<Limits> = {}) {
    const db = this.open(true);
    if (!db) throw new Error("telemetry store unavailable");
    try {
      db.transaction(() => {
        const limits = limitsSchema.parse({ ...this.limits(db), ...options });
        db.query("UPDATE settings SET value=? WHERE key='limits'").run(
          JSON.stringify(limits),
        );
        db.query(
          "INSERT INTO projects VALUES (?,?,1,?) ON CONFLICT(key) DO UPDATE SET enabled=1",
        ).run(hash(this.secret(db), this.root), randomUUID(), Date.now());
        this.prune(db, Date.now(), limits);
      }).immediate();
    } finally {
      db.close();
    }
    return this.status();
  }
  status() {
    const db = this.open(false, true);
    if (!db)
      return {
        enabled: false,
        project: null,
        since: null,
        limits: limitsSchema.parse({}),
        directory: this.directory,
      };
    try {
      const project = this.enrollment(db);
      return {
        enabled: project?.enabled === 1,
        project: project?.project ?? null,
        since: project?.since ?? null,
        limits: this.limits(db),
        directory: this.directory,
      };
    } finally {
      db.close();
    }
  }
  disable() {
    const db = this.open();
    if (db)
      try {
        db.query("UPDATE projects SET enabled=0 WHERE key=?").run(
          hash(this.secret(db), this.root),
        );
      } finally {
        db.close();
      }
    return this.status();
  }
  delete(all = false) {
    const db = this.open();
    if (!db) return;
    try {
      db.transaction(() => {
        if (all) {
          db.exec("DELETE FROM events; DELETE FROM projects;");
          db.query("UPDATE settings SET value=? WHERE key='secret'").run(
            randomUUID(),
          );
        } else {
          const project = this.enrollment(db);
          if (project)
            db.query("DELETE FROM events WHERE project=?").run(project.project);
          db.query("DELETE FROM projects WHERE key=?").run(
            hash(this.secret(db), this.root),
          );
        }
      }).immediate();
      // Best effort physical compaction, not secure erasure; active readers may defer it.
      try {
        db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
    } finally {
      db.close();
    }
  }
  /** Bounded snapshots are for inspection/reporting only, never self-instrumented. */
  events(all = false): UsageEvent[] {
    const db = this.open(false, true);
    if (!db) return [];
    try {
      const limits = this.limits(db);
      const now = Date.now();
      const project = this.enrollment(db)?.project ?? "";
      const rows = db
        .query(
          `SELECT payload FROM events WHERE ((kind='operation' AND time>=?) OR (kind='runtime' AND time>=?)) ${all ? "" : "AND project=?"} ORDER BY time,id LIMIT 11000`,
        )
        .all(
          now - limits.operationDays * 86400000,
          now - limits.runtimeDays * 86400000,
          ...(all ? [] : [project]),
        ) as { payload: string }[];
      return rows.flatMap((row) => {
        try {
          const result = eventSchema.safeParse(JSON.parse(row.payload));
          return result.success ? [result.data] : [];
        } catch {
          return [];
        }
      });
    } finally {
      db.close();
    }
  }
  /** Recheck enrollment inside the append transaction: disable/delete is immediate. */
  append(
    build: (project: string, salt: string, limits: Limits) => unknown[],
  ): "written" | "disabled" | "dropped" {
    let db: Database | undefined;
    try {
      db = this.open();
      if (!db) return "disabled";
      const connection = db;
      return connection
        .transaction(() => {
          const project = this.enrollment(connection);
          if (!project?.enabled) return "disabled" as const;
          const limits = this.limits(connection);
          const values = build(
            project.project,
            this.secret(connection),
            limits,
          );
          if (values.length > 2) return "dropped" as const;
          const events = values.map((value) => eventSchema.parse(value));
          for (const event of events) {
            const payload = JSON.stringify(event);
            if (event.project !== project.project || payload.length > 4096)
              throw new Error("invalid observation");
            connection
              .query("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?)")
              .run(event.id, event.kind, event.time, event.project, payload);
          }
          this.prune(connection, Date.now(), limits);
          return "written" as const;
        })
        .immediate();
    } catch {
      return "dropped";
    } finally {
      db?.close();
    }
  }
}

export interface Attribution {
  trigger?: OperationEvent["trigger"];
  actor?: string;
  host?: string;
  workflow?: string;
}
export interface Observation {
  operation: Operation;
  durationMs: number;
  outcome: OperationEvent["outcome"];
  error?: OperationEvent["error"];
  before?: Partial<Dimensions>;
  after?: Partial<Dimensions>;
  work?: OperationEvent["work"];
}
export class Telemetry {
  private readonly runtime = randomUUID();
  private readonly started = performance.now();
  private sampled = -Infinity;
  private dropped = 0;
  private readonly store?: TelemetryStore;
  constructor(
    root: string,
    private readonly surface: UsageEvent["surface"],
    directory?: string,
  ) {
    try {
      this.store = new TelemetryStore(root, directory);
    } catch {
      /* Observations never break work. */
    }
  }
  record(observation: Observation, attribution: Attribution = {}) {
    try {
      let sampled = false;
      const result = this.store?.append((project, salt, limits) => {
        const now = performance.now();
        const common = {
          schema: 1,
          time: Date.now(),
          project,
          runtime: this.runtime,
          uptimeMs: now - this.started,
          version: DOCKET_VERSION,
          surface: this.surface,
        };
        const after = dimensionsSchema.parse(observation.after ?? {});
        const values: unknown[] = [
          {
            ...common,
            ...observation,
            kind: "operation",
            id: randomUUID(),
            error:
              observation.error ??
              (observation.outcome === "success" ? "none" : "unknown"),
            before: dimensionsSchema.parse(observation.before ?? {}),
            after,
            trigger: attribution.trigger ?? "unknown",
            actor: ["human", "agent"].includes(attribution.actor ?? "")
              ? attribution.actor
              : "unknown",
            host: ["codex", "claude", "other"].includes(attribution.host ?? "")
              ? attribution.host
              : "unknown",
            workflow:
              attribution.workflow && attribution.workflow.length <= 256
                ? hash(salt, `${project}:${attribution.workflow}`)
                : null,
            dropped: this.dropped,
          },
        ];
        if (now - this.sampled >= limits.sampleIntervalMs) {
          values.push({
            ...common,
            kind: "runtime",
            id: randomUUID(),
            rss: process.memoryUsage.rss(),
            dimensions: after,
          });
          sampled = true;
        }
        return values;
      });
      if (result === "written") {
        this.dropped = 0;
        if (sampled) this.sampled = performance.now();
      } else if (result === "dropped") this.dropped++;
    } catch {
      this.dropped++;
    }
  }
}

/** Categorize locally; never retain the message used to classify a failure. */
export function errorCategory(error: unknown): OperationEvent["error"] {
  const code = (error as { code?: unknown })?.code;
  const name = (error as { name?: unknown })?.name;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (name === "AbortError" || code === "ABORT_ERR") return "interrupted";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (
    code === "ENOENT" ||
    /^(not found:|no item with id|unknown (task|id))/i.test(message)
  )
    return "not_found";
  if (
    code === -32602 ||
    name === "ZodError" ||
    /^(MCP error -32602|Invalid arguments|expected |invalid |error:)/i.test(
      message,
    )
  )
    return "validation";
  if (
    /^(item changed|source changed|collection changed|cannot move|invalid transition)/i.test(
      message,
    )
  )
    return "conflict";
  return "internal";
}
export function environmentAttribution(): Attribution {
  return {
    actor: process.env.DOCKET_TELEMETRY_ACTOR,
    host: process.env.DOCKET_TELEMETRY_HOST,
    workflow: process.env.DOCKET_TELEMETRY_WORKFLOW,
  };
}

export async function observeOperation<T>(
  telemetry: Telemetry | undefined,
  operation: Operation,
  run: () => Promise<T>,
  options: {
    dimensions?: () => Partial<Dimensions>;
    attribution?: Attribution;
    resultError?: (result: T) => OperationEvent["error"];
  } = {},
): Promise<T> {
  if (!telemetry) return run();
  const safeDimensions = () => {
    try {
      return options.dimensions?.() ?? {};
    } catch {
      return {};
    }
  };
  const before = safeDimensions();
  const counts = newWorkCounts();
  const start = performance.now();
  let category: OperationEvent["error"] = "none";
  try {
    const result = await workCounts.run(counts, run);
    try {
      category = options.resultError?.(result) ?? "none";
    } catch {
      category = "unknown";
    }
    return result;
  } catch (error) {
    category = errorCategory(error);
    throw error;
  } finally {
    const durationMs = performance.now() - start;
    telemetry.record(
      {
        operation,
        durationMs,
        outcome: category === "none" ? "success" : "error",
        error: category,
        before,
        after: safeDimensions(),
        work: counts,
      },
      options.attribution,
    );
  }
}
