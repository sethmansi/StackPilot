import type { GitService } from "../git/gitService.js";
import type { Stack } from "./types.js";

export type StackOperation = "sync" | "submit" | "merge" | "validate";

export interface ValidationResult {
  checks: string[];
}

export async function validateStack(
  stack: Stack,
  git: GitService,
  operation: StackOperation
): Promise<ValidationResult> {
  const checks: string[] = [];

  if (await git.isRebaseInProgress()) {
    throw new Error(
      "A Git rebase is already in progress. Continue or abort it before running StackPilot."
    );
  }
  checks.push("No Git rebase is in progress");

  if (operation !== "submit" && (await git.hasUncommittedChanges())) {
    throw new Error(
      `Working tree has uncommitted changes. Commit or stash them before ${operation}.`
    );
  }
  if (operation !== "submit") checks.push("Working tree is clean");

  const ordered = [...stack.branches].sort((a, b) => a.level - b.level);
  for (const branch of [stack.trunk, ...ordered.map((b) => b.name)]) {
    if (!(await git.branchExists(branch))) {
      throw new Error(`Branch ${branch} does not exist locally`);
    }
  }
  checks.push("All branches exist");

  for (const [index, branch] of ordered.entries()) {
    const expectedBase = index === 0 ? stack.trunk : ordered[index - 1].name;
    if (branch.base !== expectedBase) {
      throw new Error(
        `Invalid stack order: ${branch.name} should be based on ${expectedBase}, not ${branch.base}`
      );
    }

    const historyBase =
      operation === "sync"
        ? branch.lastKnownBaseSha ?? expectedBase
        : expectedBase;
    if (!(await git.isAncestor(historyBase, branch.name))) {
      throw new Error(
        `${branch.name} does not contain ${expectedBase} in its history. ` +
          `Run stackpilot sync ${stack.name} to repair the stack.`
      );
    }
    checks.push(`${branch.name} contains ${expectedBase}`);

    const mergeCommits = await git.mergeCommitsBetween(
      historyBase,
      branch.name
    );
    if (mergeCommits.length > 0) {
      throw new Error(
        `${branch.name} contains ${mergeCommits.length} merge commit(s) between stack layers. ` +
          "Use a linear history before continuing."
      );
    }
  }
  checks.push("Stack history is linear");
  return { checks };
}
