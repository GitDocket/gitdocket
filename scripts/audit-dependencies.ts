import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const AUDIT_COMMAND = ["bun", "audit", "--audit-level", "high"];
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000];

export interface AuditAttemptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface DependencyAuditOptions {
  runAttempt?: (timeoutMs: number) => Promise<AuditAttemptResult>;
  retryDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
  timeoutMs?: number;
}

const transientAuditFailures = [
  /\bConnectionClosed\b/i,
  /\bEAI_AGAIN\b/i,
  /\bECONN(?:ABORTED|REFUSED|RESET)\b/i,
  /\bENETUNREACH\b/i,
  /\bETIMEDOUT\b/i,
  /\bfetch failed\b/i,
  /\brequest timed out\b/i,
  /\bTimeout\b.*\baudit request failed\b/i,
  /\baudit request failed\s*$/i,
  /\baudit request failed.*(?:status|HTTP)\s+(?:408|425|429|5\d\d)\b/i,
];

export function isTransientAuditFailure(result: AuditAttemptResult): boolean {
  return (
    result.timedOut === true ||
    transientAuditFailures.some((pattern) => pattern.test(result.stderr))
  );
}

async function runBunAudit(timeoutMs: number): Promise<AuditAttemptResult> {
  const child = Bun.spawn({
    cmd: AUDIT_COMMAND,
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timeout));
  return { exitCode, stdout, stderr, timedOut };
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const write = (sink: (message: string) => void, message: string): void => {
  if (message.length === 0) return;
  sink(message.endsWith("\n") ? message : `${message}\n`);
};

export async function runDependencyAudit(
  options: DependencyAuditOptions = {},
): Promise<number> {
  const runAttempt = options.runAttempt ?? runBunAudit;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? wait;
  const stderr = options.stderr ?? ((message) => process.stderr.write(message));
  const stdout = options.stdout ?? ((message) => process.stdout.write(message));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = retryDelaysMs.length + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runAttempt(timeoutMs);
    write(stdout, result.stdout);
    write(stderr, result.stderr);

    if (result.exitCode === 0 && !result.timedOut) return 0;
    if (!isTransientAuditFailure(result)) return result.exitCode || 1;

    if (attempt === attempts) {
      write(
        stderr,
        `Dependency audit could not reach the npm registry after ${attempts} attempts; retry the workflow after registry connectivity recovers.`,
      );
      return 1;
    }

    const delay = retryDelaysMs[attempt - 1] ?? 0;
    const reason = result.timedOut
      ? `timed out after ${timeoutMs}ms`
      : "hit a transient registry error";
    write(
      stderr,
      `Dependency audit ${reason}; retrying attempt ${attempt + 1}/${attempts} in ${delay}ms.`,
    );
    await sleep(delay);
  }

  return 1;
}

if (import.meta.main) {
  process.exitCode = await runDependencyAudit();
}
