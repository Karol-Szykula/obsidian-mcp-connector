import { describe, expect, test, beforeEach } from "bun:test";
import {
  showFileInObsidianHandler,
  showFileInObsidianSchema,
} from "./showFileInObsidian";
import { mockApp, resetMockVault, setMockFile } from "$/test-setup";

beforeEach(() => resetMockVault());

describe("show_file_in_obsidian tool", () => {
  test("schema declares the tool name", () => {
    expect(showFileInObsidianSchema.get("name")?.toString()).toContain(
      "show_file_in_obsidian",
    );
  });

  test("opens existing file via openLinkText", async () => {
    setMockFile("Notes/welcome.md", "# Welcome");
    const app = mockApp();

    const result = await showFileInObsidianHandler({
      arguments: { filename: "Notes/welcome.md" },
      app,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/ok|opened/i);
    expect(app.workspace.getActiveFile()?.path).toBe("Notes/welcome.md");
  });

  test("refuses a missing file by default: read-only annotation must hold", async () => {
    const app = mockApp();
    const result = await showFileInObsidianHandler({
      arguments: { filename: "NewNotes/scratch.md" },
      app,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(result.content[0].text).toContain("create_vault_file");
    // Nothing written, nothing opened.
    expect(app.vault.getAbstractFileByPath("NewNotes/scratch.md")).toBeNull();
    expect(app.workspace.getActiveFile()).toBeNull();
  });

  test("ignores a legacy createIfMissing argument and still writes nothing (#631)", async () => {
    const app = mockApp();
    const result = await showFileInObsidianHandler({
      arguments: {
        filename: "NewNotes/scratch.md",
        createIfMissing: true,
      } as unknown as { filename: string },
      app,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(app.vault.getAbstractFileByPath("NewNotes/scratch.md")).toBeNull();
    expect(app.workspace.getActiveFile()).toBeNull();
  });

  test("schema no longer advertises createIfMissing", () => {
    const json = JSON.stringify(showFileInObsidianSchema.toJsonSchema());
    expect(json).not.toContain("createIfMissing");
  });

  test("respects newLeaf=true argument", async () => {
    setMockFile("a.md", "");
    const app = mockApp();
    // Just verify the call doesn't error with newLeaf=true; mock honors the same flow
    const result = await showFileInObsidianHandler({
      arguments: { filename: "a.md", newLeaf: true },
      app,
    });
    expect(result.isError).toBeUndefined();
  });
});
