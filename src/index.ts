#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { buildContext, DEFAULT_CONFIG } from "./cli/context.js";
import { dispatchComment, parseComment } from "./cli/commentCommands.js";
import {
  log,
  renderPlan,
  renderStack,
  renderStackJson,
} from "./cli/render.js";
import type { StackPilotConfig } from "./core/types.js";
import { StackStore } from "./store/stackStore.js";

const program = new Command();

program
  .name("stackpilot")
  .description("AI-assisted stacked pull request manager for Azure DevOps")
  .version("0.1.0");

// ---- init ---------------------------------------------------------------
program
  .command("init")
  .description("Initialize StackPilot config in the current directory")
  .option("--provider <provider>", "provider: mock | ado", "mock")
  .option("--ai <ai>", "ai provider: mock", "mock")
  .option("--org <url>", "Azure DevOps organization URL")
  .option("--project <project>", "Azure DevOps project")
  .option("--repo <repository>", "repository name")
  .option("--trunk <branch>", "trunk/integration branch", "main")
  .option("--no-approval", "do not require approval for mutating operations")
  .action(async (opts) => {
    const store = new StackStore(process.cwd());
    await store.load();
    const config: StackPilotConfig = {
      ...DEFAULT_CONFIG,
      provider: opts.provider,
      ai: opts.ai,
      organizationUrl: opts.org,
      project: opts.project,
      repository: opts.repo,
      trunk: opts.trunk,
      requireApproval: opts.approval !== false,
    };
    await store.setConfig(config);
    log.ok(`Initialized StackPilot (${config.provider} provider, trunk ${config.trunk})`);
    if (config.provider === "ado" && !process.env.AZURE_DEVOPS_PAT) {
      log.warn("Set AZURE_DEVOPS_PAT to enable the real Azure DevOps provider.");
    }
    log.info(chalk.dim(`Config saved to ${store.path}`));
  });

// ---- create -------------------------------------------------------------
program
  .command("create <name> <bottomBranch>")
  .description("Create a new stack with its bottom branch")
  .option("--trunk <branch>", "override trunk for this stack")
  .action(async (name, bottomBranch, opts) => {
    const ctx = await buildContext();
    const trunk = opts.trunk ?? ctx.config.trunk;
    const stack = await ctx.engine.createStack(name, trunk, bottomBranch);
    log.ok(`Created stack "${stack.name}"`);
    console.log(renderStack(stack, []));
  });

// ---- push ---------------------------------------------------------------
program
  .command("push <stack> <branch>")
  .description("Push a branch onto the top of a stack")
  .action(async (stackName, branch) => {
    const ctx = await buildContext();
    const stack = await ctx.engine.push(stackName, branch);
    log.ok(`Pushed ${branch} onto ${stackName}`);
    console.log(renderStack(stack, await ctx.engine.prsFor(stack)));
  });

// ---- pr (create PRs) ----------------------------------------------------
program
  .command("pr <stack>")
  .description("Open pull requests for stacked branches, with dependency links")
  .option("--draft", "open as draft PRs", false)
  .action(async (stackName, opts) => {
    const ctx = await buildContext();
    const created = await ctx.engine.createPullRequests(stackName, { draft: opts.draft });
    if (created.length === 0) {
      log.info("All branches already have PRs.");
    } else {
      for (const pr of created) {
        log.ok(`Opened PR !${pr.id}: ${pr.sourceBranch} → ${pr.targetBranch}`);
        log.info(chalk.dim("   " + pr.url));
      }
    }
    const stack = ctx.engine.requireStack(stackName);
    console.log(renderStack(stack, await ctx.engine.prsFor(stack)));
  });

// ---- submit -------------------------------------------------------------
program
  .command("submit <stack>")
  .description("Push branches and create or update all stacked pull requests")
  .option("--apply", "execute (or request approval for) the plan", false)
  .action(async (stackName, opts) => {
    const ctx = await buildContext();
    const result = await ctx.engine.submit(stackName, opts.apply);
    log.title("Submit");
    console.log(renderPlan(result.messages, result.operations));
    if (result.approval) {
      log.warn(`Approval required: stackpilot approve ${result.approval.id}`);
    } else if (result.applied) {
      log.ok("Submit applied.");
    }
  });

// ---- describe -----------------------------------------------------------
program
  .command("describe <stack> [branch]")
  .description("AI-generate reviewer-friendly PR descriptions")
  .option("--show", "print the generated description(s)", false)
  .action(async (stackName, branch, opts) => {
    const ctx = await buildContext();
    const updated = await ctx.engine.describe(stackName, branch);
    log.ok(`Updated ${updated.length} PR description(s).`);
    if (opts.show) {
      for (const pr of updated) {
        console.log(chalk.bold(`\n──── PR !${pr.id} (${pr.sourceBranch}) ────`));
        console.log(pr.description);
      }
    }
  });

// ---- status -------------------------------------------------------------
program
  .command("status <stack>")
  .description("Show a stack and its PR states")
  .option("--json", "output machine-readable JSON", false)
  .action(async (stackName, opts) => {
    const ctx = await buildContext();
    const stack = ctx.engine.requireStack(stackName);
    const prs = await ctx.engine.prsFor(stack);
    console.log(
      opts.json ? renderStackJson(stack, prs) : renderStack(stack, prs)
    );
  });

// ---- list ---------------------------------------------------------------
program
  .command("list")
  .description("List all stacks")
  .action(async () => {
    const ctx = await buildContext();
    const stacks = ctx.store.listStacks();
    if (!stacks.length) return log.info("No stacks yet. Create one with `stackpilot create`.");
    for (const s of stacks) {
      log.info(`${chalk.cyan(s.name)} — ${s.branches.length} branch(es), trunk ${s.trunk}`);
    }
  });

// ---- sync ---------------------------------------------------------------
program
  .command("sync <stack>")
  .description("Detect drift and restack branches onto their updated bases")
  .option("--apply", "execute (or request approval for) the plan", false)
  .option("--dry-run", "preview the sync plan without executing", false)
  .action(async (stackName, opts) => {
    if (opts.apply && opts.dryRun) {
      throw new Error("Use either --apply or --dry-run, not both");
    }
    const ctx = await buildContext();
    const result = await ctx.engine.sync(stackName, opts.apply);
    log.title(opts.apply ? "Sync" : "Sync dry run");
    console.log(renderPlan(result.messages, result.operations));
    if (result.approval) log.warn(`Approval required: stackpilot approve ${result.approval.id}`);
    else if (result.applied) log.ok("Sync applied.");
  });

// ---- validate -----------------------------------------------------------
program
  .command("validate <stack>")
  .description("Check whether a local stack is safe to submit, sync, or merge")
  .action(async (stackName) => {
    const ctx = await buildContext();
    const result = await ctx.engine.validate(stackName);
    for (const check of result.checks) log.ok(check);
  });

// ---- merge --------------------------------------------------------------
program
  .command("merge <stack>")
  .description("Merge the bottom PR and restack the rest")
  .option("--apply", "execute (or request approval for) the plan", false)
  .action(async (stackName, opts) => {
    const ctx = await buildContext();
    const result = await ctx.engine.merge(stackName, opts.apply);
    log.title("Merge & restack");
    console.log(renderPlan(result.messages, result.operations));
    if (result.approval) log.warn(`Approval required: stackpilot approve ${result.approval.id}`);
    else if (result.applied) log.ok("Merge applied.");
  });

// ---- review -------------------------------------------------------------
program
  .command("review <stack>")
  .description("Generate a stack-aware review summary")
  .option("--post", "post the summary as a comment on the bottom PR", false)
  .action(async (stackName, opts) => {
    const ctx = await buildContext();
    const summary = await ctx.engine.reviewSummary(stackName, opts.post);
    console.log("\n" + summary);
    if (opts.post) log.ok("Posted to bottom PR.");
  });

// ---- approvals ----------------------------------------------------------
program
  .command("approvals")
  .description("List approval requests")
  .option("--pending", "only pending", false)
  .action(async (opts) => {
    const ctx = await buildContext();
    const reqs = ctx.store.listApprovals(opts.pending ? "pending" : undefined);
    if (!reqs.length) return log.info("No approval requests.");
    for (const r of reqs) {
      const color = r.status === "pending" ? chalk.yellow : r.status === "approved" ? chalk.green : chalk.red;
      log.info(`${color(r.status.padEnd(8))} ${chalk.dim(r.id)}  ${r.description} (${r.operations.length} ops)`);
    }
  });

program
  .command("approve <approvalId>")
  .description("Approve and execute a pending operation")
  .action(async (id) => {
    const ctx = await buildContext();
    const result = await ctx.engine.approve(id);
    log.ok(result.messages.join(" "));
    console.log(renderPlan([], result.operations));
  });

program
  .command("deny <approvalId>")
  .description("Deny a pending operation")
  .action(async (id) => {
    const ctx = await buildContext();
    await ctx.engine.deny(id);
    log.ok(`Denied ${id}.`);
  });

// ---- navigation ---------------------------------------------------------
const navigationDescriptions = {
  top: "Switch to the top branch of a stack",
  bottom: "Switch to the bottom branch of a stack",
  up: "Switch one branch toward the top of a stack",
  down: "Switch one branch toward the trunk of a stack",
  trunk: "Switch to the trunk branch of a stack",
} as const;

for (const target of ["top", "bottom", "up", "down", "trunk"] as const) {
  program
    .command(`${target} <stack>`)
    .description(navigationDescriptions[target])
    .action(async (stackName) => {
      const ctx = await buildContext();
      const branch = await ctx.engine.navigate(stackName, target);
      log.ok(`Switched to ${branch}`);
    });
}

program
  .command("checkout <branch-or-pr>")
  .description("Switch to a local stack branch by branch name or PR ID")
  .action(async (branchOrPr) => {
    const ctx = await buildContext();
    const result = await ctx.engine.checkout(branchOrPr);
    log.ok(`Switched to ${result.branch} in stack ${result.stack.name}`);
  });

// ---- comment (simulate comment-based command) ---------------------------
program
  .command("comment <stack> <text...>")
  .description('Run a comment-based command, e.g. comment mystack "/stackpilot sync"')
  .option("--apply", "allow the command to perform mutating actions", false)
  .action(async (stackName, textParts, opts) => {
    const ctx = await buildContext();
    const text = textParts.join(" ");
    const cmd = parseComment(text);
    if (!cmd) {
      log.warn("Not a StackPilot command. Prefix with /stackpilot, /sp, or @stackpilot.");
      return;
    }
    console.log(chalk.dim(`💬 ${ctx.config.actor}: ${text}`));
    const result = await dispatchComment(ctx.engine, ctx.ai, stackName, cmd, { apply: opts.apply });
    console.log(chalk.cyan("🤖 StackPilot:"));
    console.log(result.reply);
  });

// ---- audit --------------------------------------------------------------
program
  .command("audit [stack]")
  .description("Show the audit trail")
  .option("-n, --limit <n>", "max events", "50")
  .action(async (stackName, opts) => {
    const ctx = await buildContext();
    const stack = stackName ? ctx.engine.requireStack(stackName) : undefined;
    const events = ctx.store.getAudit(stack?.id).slice(-Number(opts.limit));
    if (!events.length) return log.info("No audit events yet.");
    log.title("Audit trail");
    for (const e of events) {
      const ts = chalk.dim(e.timestamp.replace("T", " ").slice(0, 19));
      const tag = e.applied ? chalk.green("APPLIED") : chalk.yellow("PLANNED");
      console.log(`${ts} ${tag} ${chalk.magenta(e.action)} ${chalk.dim("by " + e.actor)}`);
      console.log(`   ${e.summary}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  log.err(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
