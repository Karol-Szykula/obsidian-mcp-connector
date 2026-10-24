/**
 * Which tokens the Access Control migration notice offers (#625,
 * ADR-0025 amendment).
 *
 * New tokens default to `adaptive` (ADR-0023 D11), but a token created
 * before that stays on `all` until someone flips its migrate toggle in
 * the Tool Loading panel, which few users find. The notice lists the
 * tokens that toggle would accept right now, with the same preview the
 * toggle's confirmation shows, so the saving is visible where the
 * tokens are.
 *
 * Pure and Obsidian-free, like `migrationViewState.ts`: the component
 * gathers the inputs, this decides. It never writes; migrating still
 * goes through the panel's toggle, the only writer of `profile`
 * (ADR-0025 D11, A8).
 */

import { resolveToolScope } from "../resolveToolScope";
import type { TokenPolicy } from "../tokenPolicyStore";
import { migrationEligibility } from "./migrationEligibility";
import { planMigration } from "./planMigration";

export type MigrationNoticeToken = {
  id: string;
  label: string;
  createdAt: number;
};

export type MigrationNoticeInput = {
  now: number;
  /** `0` before the anchor exists: nothing has been observed yet. */
  everCalledSince: number;
  /** The registry's served names only (ADR-0025 D8). */
  servedNames: readonly string[];
  tokens: readonly MigrationNoticeToken[];
  policies: Readonly<Record<string, TokenPolicy>>;
  everCalled: Readonly<Record<string, readonly string[]>>;
  dismissed: readonly string[];
};

export type MigrationNoticeEntry = {
  tokenId: string;
  label: string;
  /** Tools the token loads today. */
  activeNow: number;
  /** Tools it would load after migrating. */
  activeAfter: number;
  /** What would go inactive until called through `activate_tool`. */
  deactivated: string[];
};

/**
 * One entry per token that is on `all`, past its observation window,
 * not dismissed, and would actually load fewer tools after migrating.
 * Empty while the registry has no served names, since the preview
 * would be wrong.
 */
export function migrationNoticeEntries(
  input: MigrationNoticeInput,
): MigrationNoticeEntry[] {
  const { servedNames } = input;
  if (input.everCalledSince === 0 || servedNames.length === 0) return [];

  const entries: MigrationNoticeEntry[] = [];
  for (const token of input.tokens) {
    if (input.dismissed.includes(token.id)) continue;
    const policy = input.policies[token.id];
    if (!policy || policy.profile !== "all") continue;
    const { eligible } = migrationEligibility(
      input.now,
      input.everCalledSince,
      token.createdAt,
    );
    if (!eligible) continue;

    const plan = planMigration([...servedNames], policy, [
      ...(input.everCalled[token.id] ?? []),
    ]);
    if (plan.deactivated.length === 0) continue;
    const activeNow = resolveToolScope(token.id, policy, servedNames).active
      .size;
    entries.push({
      tokenId: token.id,
      label: token.label,
      activeNow,
      // all → adaptive only narrows, so the difference is exact
      activeAfter: activeNow - plan.deactivated.length,
      deactivated: plan.deactivated,
    });
  }
  return entries;
}
