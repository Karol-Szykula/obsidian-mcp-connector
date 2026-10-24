import { describe, expect, test } from "bun:test";
import {
  __trackedChildCount,
  killTrackedChildren,
  trackedExecFile,
} from "./childProcesses";

// The test runner's own binary is the one program certain to exist.
const runtime = process.execPath;

describe("childProcesses", () => {
  test("a finished child is forgotten and its output returned", async () => {
    const result = await trackedExecFile(runtime, ["-e", "console.log('hi')"]);
    expect(result.stdout.trim()).toBe("hi");
    expect(__trackedChildCount()).toBe(0);
    expect(killTrackedChildren()).toBe(0);
  });

  test("a failed child rejects with its output attached", async () => {
    const failure = trackedExecFile(runtime, [
      "-e",
      "console.error('bad'); process.exit(3)",
    ]);
    await expect(failure).rejects.toMatchObject({ code: 3, stderr: "bad\n" });
    expect(__trackedChildCount()).toBe(0);
  });

  test("killTrackedChildren ends a child still running", async () => {
    const pending = trackedExecFile(runtime, [
      "-e",
      "setTimeout(() => {}, 30_000)",
    ]);
    expect(__trackedChildCount()).toBe(1);

    const started = Date.now();
    expect(killTrackedChildren()).toBe(1);
    await expect(pending).rejects.toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(__trackedChildCount()).toBe(0);
  });
});
