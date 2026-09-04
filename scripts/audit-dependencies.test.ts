import { describe, expect, test } from "bun:test";
import {
  type AuditAttemptResult,
  isTransientAuditFailure,
  runDependencyAudit,
} from "./audit-dependencies";

const transportFailure = (stderr: string): AuditAttemptResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

const quietOutput = {
  stderr: (_message: string): void => {},
  stdout: (_message: string): void => {},
};

describe("dependency audit retry policy", () => {
  test("recognizes registry transport failures and explicit timeouts", () => {
    expect(
      isTransientAuditFailure(
        transportFailure("error: audit request failed (status 503)"),
      ),
    ).toBeTrue();
    expect(
      isTransientAuditFailure(
        transportFailure("ConnectionClosed: audit request failed"),
      ),
    ).toBeTrue();
    expect(
      isTransientAuditFailure({
        ...transportFailure(""),
        timedOut: true,
      }),
    ).toBeTrue();
    expect(
      isTransientAuditFailure(
        transportFailure("error: audit request failed (status 400)"),
      ),
    ).toBeFalse();
  });

  test("retries bounded transient failures and then succeeds", async () => {
    const results: AuditAttemptResult[] = [
      transportFailure("ConnectionClosed: audit request failed"),
      transportFailure("error: audit request failed (status 503)"),
      { exitCode: 0, stdout: "No vulnerabilities found", stderr: "" },
    ];
    const delays: number[] = [];

    const exitCode = await runDependencyAudit({
      ...quietOutput,
      retryDelaysMs: [5, 15],
      runAttempt: async () => results.shift() as AuditAttemptResult,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(exitCode).toBe(0);
    expect(delays).toEqual([5, 15]);
    expect(results).toHaveLength(0);
  });

  test("fails immediately on a real high-severity advisory", async () => {
    let attempts = 0;
    const exitCode = await runDependencyAudit({
      ...quietOutput,
      retryDelaysMs: [5, 15],
      runAttempt: async () => {
        attempts += 1;
        return {
          exitCode: 1,
          stdout: "1 vulnerability (1 high)",
          stderr: "",
        };
      },
      sleep: async () => {
        throw new Error("advisories must not be retried");
      },
    });

    expect(exitCode).toBe(1);
    expect(attempts).toBe(1);
  });

  test("stops after the configured attempts with an actionable error", async () => {
    let attempts = 0;
    const errors: string[] = [];
    const exitCode = await runDependencyAudit({
      retryDelaysMs: [5, 15],
      runAttempt: async () => {
        attempts += 1;
        return transportFailure("ConnectionClosed: audit request failed");
      },
      sleep: async () => {},
      stderr: (message) => errors.push(message),
      stdout: quietOutput.stdout,
    });

    expect(exitCode).toBe(1);
    expect(attempts).toBe(3);
    expect(errors.at(-1)).toContain("after 3 attempts");
    expect(errors.at(-1)).toContain("registry connectivity recovers");
  });
});
