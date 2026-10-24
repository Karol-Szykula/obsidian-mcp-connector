import { type } from "arktype";
import { errorJson, successText } from "../services/responseBuilders";
import type { App } from "obsidian";

export const showFileInObsidianSchema = type({
  name: '"show_file_in_obsidian"',
  arguments: {
    filename: type("string>0").describe(
      "Vault-relative path (e.g. 'Notes/foo.md') of an existing file.",
    ),
    "newLeaf?": type("boolean").describe(
      "Open in a new leaf (split) instead of the active one. Default false.",
    ),
  },
}).describe(
  "Opens an existing file in the Obsidian UI, optionally in a new leaf (split). Read-only: a missing file is a file_not_found error. To open a new note, create it with create_vault_file first.",
);

export type ShowFileInObsidianContext = {
  arguments: { filename: string; newLeaf?: boolean };
  app: App;
};

export async function showFileInObsidianHandler(
  ctx: ShowFileInObsidianContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { filename, newLeaf } = ctx.arguments;
  // `openLinkText` creates a missing target as a side effect. Resolve
  // existence first so this tool never writes, which is what its
  // read-only annotation promises (#631).
  if (!ctx.app.vault.getAbstractFileByPath(filename)) {
    return errorJson(
      `File not found: ${filename}. To open a new note, create it with create_vault_file, then call show_file_in_obsidian again.`,
      "file_not_found",
      { path: filename },
    );
  }
  await ctx.app.workspace.openLinkText(filename, "", newLeaf ?? false);
  return successText("File opened successfully");
}
