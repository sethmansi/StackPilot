import chalk from "chalk";
import type { PullRequest, Stack } from "../core/types.js";

export interface StackStatus {
  id: string;
  name: string;
  repository: string;
  trunk: string;
  branches: Array<{
    level: number;
    name: string;
    targetBranch: string;
    prId: number | null;
    status: PullRequest["status"] | "not_created";
    dependsOn: number[];
  }>;
}

export function buildStackStatus(
  stack: Stack,
  prs: PullRequest[]
): StackStatus {
  const byBranch = new Map(prs.map((pr) => [pr.sourceBranch, pr]));
  return {
    id: stack.id,
    name: stack.name,
    repository: stack.repository,
    trunk: stack.trunk,
    branches: [...stack.branches]
      .sort((a, b) => a.level - b.level)
      .map((branch) => {
        const pr = byBranch.get(branch.name);
        return {
          level: branch.level,
          name: branch.name,
          targetBranch: pr?.targetBranch ?? branch.base,
          prId: pr?.id ?? null,
          status: pr?.status ?? "not_created",
          dependsOn: pr?.dependsOn ?? [],
        };
      }),
  };
}

export function renderStackJson(stack: Stack, prs: PullRequest[]): string {
  return JSON.stringify(buildStackStatus(stack, prs), null, 2);
}

export function renderStack(stack: Stack, prs: PullRequest[]): string {
  const byBranch = new Map(prs.map((p) => [p.sourceBranch, p]));
  const ordered = [...stack.branches].sort((a, b) => b.level - a.level);
  const lines: string[] = [];
  lines.push(chalk.bold(`\n📚 Stack: ${chalk.cyan(stack.name)}  ${chalk.dim("(" + stack.repository + ")")}`));
  lines.push(chalk.dim(`   trunk: ${stack.trunk}\n`));

  for (const b of ordered) {
    const pr = byBranch.get(b.name);
    const indent = "   " + "  ".repeat(b.level);
    const connector = chalk.dim("│");
    const prPart = pr
      ? `${chalk.yellow("!" + pr.id)} ${statusBadge(pr)} ${chalk.dim(pr.dependsOn.length ? "depends on !" + pr.dependsOn.join(", !") : "")}`
      : chalk.dim("(no PR)");
    lines.push(`${indent}${chalk.green("◆")} ${chalk.bold(b.name)} ${chalk.dim("→ " + b.base)}  ${prPart}`);
    lines.push(`${indent}${connector}`);
  }
  lines.push(`   ${chalk.blue("◇")} ${chalk.bold(stack.trunk)} ${chalk.dim("(trunk)")}`);
  return lines.join("\n");
}

function statusBadge(pr: PullRequest): string {
  switch (pr.status) {
    case "draft":
      return chalk.gray("[draft]");
    case "active":
      return chalk.green("[active]");
    case "completed":
      return chalk.blue("[merged]");
    case "abandoned":
      return chalk.red("[abandoned]");
  }
}

export function renderPlan(messages: string[], operations: { command: string; description: string }[]): string {
  const lines: string[] = [];
  for (const m of messages) lines.push("  " + m);
  if (operations.length) {
    lines.push(chalk.bold("\n  Planned operations:"));
    for (const op of operations) {
      lines.push(`    ${chalk.magenta("$")} ${op.command}`);
      lines.push(`      ${chalk.dim(op.description)}`);
    }
  }
  return lines.join("\n");
}

export const log = {
  info: (m: string) => console.log(m),
  ok: (m: string) => console.log(chalk.green("✓ ") + m),
  warn: (m: string) => console.log(chalk.yellow("⚠ ") + m),
  err: (m: string) => console.error(chalk.red("✗ ") + m),
  title: (m: string) => console.log(chalk.bold.cyan("\n" + m)),
};
