import { rm } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { MockAIProvider } from "../ai/mockAi.js";
import { StackManager } from "../core/stackManager.js";
import type { StackPilotConfig } from "../core/types.js";
import { MockGitService } from "../git/gitService.js";
import { MockProvider } from "../providers/mock/mockProvider.js";
import { StackStore } from "../store/stackStore.js";
import { dispatchComment, parseComment } from "../cli/commentCommands.js";
import { renderStack } from "../cli/render.js";

/**
 * End-to-end offline demo of StackPilot: build a 3-PR stack, open linked PRs,
 * generate AI descriptions, review it, simulate upstream drift + restack, run a
 * comment-based command through the approval gate, then merge and restack.
 */
async function main() {
  const root = join(process.cwd(), "demo-workspace");
  await rm(join(root, ".stackpilot"), { recursive: true, force: true });

  const seed = {
    branchCommits: {
      "feature/auth-schema": [
        "Add users and sessions tables",
        "Add migration for auth schema",
      ],
      "feature/auth-service": [
        "Implement TokenService with JWT signing",
        "Add password hashing via argon2",
        "Wire AuthService into DI container",
      ],
      "feature/auth-api": [
        "Add POST /login and /refresh endpoints",
        "Add auth middleware and rate limiting",
      ],
    } as Record<string, string[]>,
    branchFiles: {
      "feature/auth-schema": [
        "db/migrations/001_auth.sql",
        "db/schema.sql",
      ],
      "feature/auth-service": [
        "src/auth/tokenService.ts",
        "src/auth/passwords.ts",
        "src/auth/authService.ts",
        "src/di/container.ts",
      ],
      "feature/auth-api": [
        "src/api/routes/auth.ts",
        "src/api/middleware/auth.ts",
        "src/api/middleware/rateLimit.ts",
      ],
    } as Record<string, string[]>,
  };

  const store = new StackStore(root);
  await store.load();
  const config: StackPilotConfig = {
    provider: "mock",
    ai: "mock",
    trunk: "main",
    repository: "payments-service",
    requireApproval: true,
    actor: "ada",
  };
  await store.setConfig(config);

  const provider = new MockProvider({
    branches: ["main"],
    repositoryUrl:
      "https://dev.azure.com/contoso/Payments/_git/payments-service",
    persistFile: join(root, ".stackpilot", "mock-provider.json"),
  });
  const git = new MockGitService(seed);
  const ai = new MockAIProvider();
  const engine = new StackManager({ provider, git, ai, store, config });

  step("1. Create a stack and push dependent branches");
  await engine.createStack("auth-feature", "main", "feature/auth-schema");
  await engine.push("auth-feature", "feature/auth-service");
  await engine.push("auth-feature", "feature/auth-api");
  let stack = engine.requireStack("auth-feature");
  console.log(renderStack(stack, []));

  step("2. Submit branches and linked pull requests (bottom-up)");
  const submitPlan = await engine.submit("auth-feature", true);
  if (submitPlan.approval) await engine.approve(submitPlan.approval.id);
  for (const pr of await engine.prsFor(stack)) {
    console.log(`   ${chalk.green("✓")} PR !${pr.id}  ${pr.sourceBranch} → ${pr.targetBranch}  ${pr.dependsOn.length ? chalk.dim("depends on !" + pr.dependsOn.join(", !")) : ""}`);
  }
  const repeated = await engine.submit("auth-feature", true);
  if (repeated.approval) await engine.approve(repeated.approval.id);
  console.log(chalk.dim("   Repeated submit reused all existing PRs"));
  stack = engine.requireStack("auth-feature");
  console.log(renderStack(stack, await engine.prsFor(stack)));

  step("3. AI-generated reviewer-friendly description (middle PR)");
  const described = await engine.describe("auth-feature", "feature/auth-service");
  console.log(described[0]?.description);

  step("4. Stack-aware review summary");
  console.log(await engine.reviewSummary("auth-feature", false));

  step("5. Upstream drift → StackPilot detects and plans a restack");
  git.bumpSha("feature/auth-schema"); // simulate a new commit on the bottom branch
  const syncPlan = await engine.sync("auth-feature", false);
  syncPlan.messages.forEach((m) => console.log("   " + m));

  step("6. Comment-based command through the approval gate");
  const cmd = parseComment("/stackpilot sync")!;
  console.log(chalk.dim("   💬 ada commented: /stackpilot sync --apply"));
  const commentResult = await dispatchComment(engine, ai, "auth-feature", cmd, { apply: true });
  console.log("   🤖 " + commentResult.reply.replace(/\n/g, "\n   "));
  const pending = store.listApprovals("pending");
  if (pending[0]) {
    console.log(chalk.dim(`   ⏳ Approval ${pending[0].id} pending — granting...`));
    const applied = await engine.approve(pending[0].id);
    console.log("   " + chalk.green("✓ ") + applied.messages.join(" "));
    console.log(chalk.dim("   git ops executed: " + git.applied.map((o) => o.command).join(" ; ")));
  }

  step("7. Merge the bottom PR and restack the rest");
  const mergePlan = await engine.merge("auth-feature", true);
  mergePlan.messages.forEach((m) => console.log("   " + m));
  if (mergePlan.approval) {
    const applied = await engine.approve(mergePlan.approval.id);
    console.log("   " + chalk.green("✓ ") + applied.messages.join(" "));
  }
  stack = engine.requireStack("auth-feature");
  console.log(renderStack(stack, await engine.prsFor(stack)));

  step("8. Audit trail (append-only)");
  for (const e of store.getAudit(stack.id)) {
    const tag = e.applied ? chalk.green("APPLIED") : chalk.yellow("PLANNED");
    console.log(`   ${tag} ${chalk.magenta(e.action)} — ${e.summary}`);
  }

  console.log(chalk.bold.green("\n✅ Demo complete. State persisted under demo-workspace/.stackpilot/state.json\n"));
}

function step(title: string) {
  console.log(chalk.bold.cyan(`\n━━━ ${title} ${"━".repeat(Math.max(0, 60 - title.length))}`));
}

main().catch((err) => {
  console.error(chalk.red(err instanceof Error ? err.stack : String(err)));
  process.exit(1);
});
