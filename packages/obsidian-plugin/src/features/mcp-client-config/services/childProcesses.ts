/**
 * Child processes the plugin starts, remembered until they exit, so that
 * unloading the plugin can end them.
 *
 * `node --version`, `brew --version` and the `npx mcp-remote` pre-warm
 * are short, but a pre-warm can run for up to two minutes and nothing
 * ended it when the plugin was disabled: its callbacks, and the plugin
 * instance they close over, stayed alive until it exited (ADR-0032).
 * `brew install node` is deliberately not tracked: a half-finished
 * install is worse than one that outlives the plugin.
 */
import { execFile, type ChildProcess } from "child_process";

export type ExecOptions = {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
};

const running = new Set<ChildProcess>();

/**
 * `execFile` as a promise, like `util.promisify(execFile)`: resolves with
 * `{stdout, stderr}`, rejects with the error carrying `stdout` and
 * `stderr`. No shell unless `options.shell` asks for one.
 */
export function trackedExecFile(
  file: string,
  args: string[],
  options?: ExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        running.delete(child);
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    running.add(child);
  });
}

/**
 * Sends SIGTERM to every tracked child still running and forgets them.
 * Their promises reject as a killed `execFile` does. Returns how many
 * were signalled.
 */
export function killTrackedChildren(): number {
  let killed = 0;
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null && child.kill()) {
      killed += 1;
    }
  }
  running.clear();
  return killed;
}

/** Test-only: how many children are tracked right now. */
export function __trackedChildCount(): number {
  return running.size;
}
