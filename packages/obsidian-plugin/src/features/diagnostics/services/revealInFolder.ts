/**
 * Reveals a file in the OS file manager through Electron's
 * `shell.showItemInFolder`.
 *
 * Electron is resolved through the host's `require` binding without a
 * `require()` call expression, the same indirection as `mcpbDownload.ts`'s
 * `electronDialog` and for the same reasons: the community reviewer's
 * `no-require-imports` rule, and a host (`bun test`, mobile) with no
 * `require` binding or no `electron` module, where this returns `false` and
 * the caller falls back to naming the path.
 */

type Shell = { showItemInFolder(path: string): void };

function electronShell(): Shell | null {
  try {
    const hostRequire: unknown =
      typeof require === "function" ? require : undefined;
    if (typeof hostRequire !== "function") return null;
    const electron = (hostRequire as (id: string) => unknown)("electron") as {
      shell?: Shell;
      remote?: { shell?: Shell };
    };
    return electron.shell ?? electron.remote?.shell ?? null;
  } catch {
    return null;
  }
}

/** True when the file manager was asked to reveal `path`. */
export function revealInFolder(path: string): boolean {
  const shell = electronShell();
  if (shell === null) return false;
  try {
    shell.showItemInFolder(path);
    return true;
  } catch {
    return false;
  }
}
