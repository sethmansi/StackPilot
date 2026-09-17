import { randomUUID } from "node:crypto";
import type { AIProvider } from "../ai/aiProvider.js";
import type { GitService } from "../git/gitService.js";
import type { Provider } from "../providers/provider.js";
import type { StackStore } from "../store/stackStore.js";
import type {
  ApprovalRequest,
  PlannedOperation,
  PullRequest,
  Stack,
  StackedBranch,
  StackEffect,
  StackPilotConfig,
} from "./types.js";
import {
  validateStack,
  type ValidationResult,
} from "./stackValidator.js";

export interface EngineDeps {
  provider: Provider;
  git: GitService;
  ai: AIProvider;
  store: StackStore;
  config: StackPilotConfig;
}

export interface PlanResult {
  operations: PlannedOperation[];
  applied: boolean;
  approval?: ApprovalRequest;
  messages: string[];
}

export interface SyncItem {
  branch: string;
  base: string;
  drifted: boolean;
  operations: PlannedOperation[];
}

export interface CheckoutResult {
  stack: Stack;
  branch: string;
}

export type NavigationTarget = "top" | "bottom" | "up" | "down" | "trunk";

/**
 * The StackPilot engine. Owns the stack lifecycle: create → push → open PRs →
 * describe → sync/restack → review → merge, emitting an audit event for every
 * meaningful action and gating mutating git/provider work behind approvals.
 */
export class StackManager {
  constructor(private readonly deps: EngineDeps) {}

  private get actor(): string {
    return this.deps.config.actor;
  }

  // ---- stack lifecycle --------------------------------------------------

  async createStack(
    name: string,
    trunk: string,
    bottomBranch: string
  ): Promise<Stack> {
    const existing = this.deps.store.getStack(name);
    if (existing) throw new Error(`Stack "${name}" already exists`);

    const now = new Date().toISOString();
    const [branchSha, baseSha] = await Promise.all([
      safeSha(this.deps.git, bottomBranch),
      safeSha(this.deps.git, trunk),
    ]);
    const stack: Stack = {
      id: randomUUID(),
      name,
      trunk,
      repository: this.deps.config.repository ?? "demo",
      branches: [
        {
          level: 0,
          name: bottomBranch,
          base: trunk,
          lastKnownSha: branchSha,
          lastKnownBaseSha: baseSha,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.saveStack(stack);
    await this.deps.store.appendAudit({
      action: "stack.create",
      actor: this.actor,
      stackId: stack.id,
      summary: `Created stack "${name}" on trunk ${trunk} with bottom branch ${bottomBranch}`,
      applied: true,
    });
    return stack;
  }

  /** Add a branch on top of the current top of the stack. */
  async push(stackName: string, branch: string): Promise<Stack> {
    const stack = this.requireStack(stackName);
    if (stack.branches.some((b) => b.name === branch)) {
      throw new Error(`Branch ${branch} already in stack`);
    }
    const top = topBranch(stack);
    const level = stack.branches.length;
    const [branchSha, baseSha] = await Promise.all([
      safeSha(this.deps.git, branch),
      safeSha(this.deps.git, top.name),
    ]);
    stack.branches.push({
      level,
      name: branch,
      base: top.name,
      lastKnownSha: branchSha,
      lastKnownBaseSha: baseSha,
    });
    await this.deps.store.saveStack(stack);
    await this.deps.store.appendAudit({
      action: "stack.push",
      actor: this.actor,
      stackId: stack.id,
      summary: `Pushed ${branch} onto stack (base: ${top.name})`,
      applied: true,
    });
    return stack;
  }

  // ---- pull requests ----------------------------------------------------

  /**
   * Push every branch and make its active PR match the stack, bottom-up.
   * Existing PRs are reused so this operation is safe to run repeatedly.
   */
  async submit(stackName: string, apply: boolean): Promise<PlanResult> {
    const stack = this.requireStack(stackName);
    await validateStack(stack, this.deps.git, "submit");
    const operations = await this.planSubmit(stack);
    const messages = operations.map((operation) => operation.description);

    return this.runOrGate({
      stack,
      action: "stack.submit",
      description: `Submit ${stack.name}`,
      operations,
      apply,
      messages,
      effect: { kind: "submit", stackId: stack.id },
    });
  }

  private async planSubmit(stack: Stack): Promise<PlannedOperation[]> {
    const operations: PlannedOperation[] = [];
    const activeByBranch = activePullRequestsByBranch(
      await this.deps.provider.listPullRequests()
    );
    let basePr: PullRequest | undefined;
    let baseBranch: string | undefined;

    for (const branch of [...stack.branches].sort(
      (a, b) => a.level - b.level
    )) {
      operations.push(this.deps.git.planPush(branch.name, false));
      const dependsOn = basePr ? [basePr.id] : [];
      const pr = activeByBranch.get(branch.name);
      const dependency = basePr ? String(basePr.id) : baseBranch;

      if (!pr) {
        operations.push({
          kind: "provider",
          command: `ado pr create --source ${branch.name} --target ${branch.base}`,
          description: `Create PR for ${branch.name} → ${branch.base}`,
          mutating: true,
        });
        if (baseBranch) {
          const dependencyLabel = basePr ? `PR !${basePr.id}` : baseBranch;
          operations.push({
            kind: "provider",
            command: `ado pr link --source ${branch.name} --depends-on ${dependency}`,
            description: `Link ${branch.name} to depend on ${dependencyLabel}`,
            mutating: true,
          });
        }
      } else {
        const targetChanged = pr.targetBranch !== branch.base;
        const dependencyChanged = baseBranch
          ? !basePr || !sameNumbers(pr.dependsOn, dependsOn)
          : pr.dependsOn.length > 0;
        if (targetChanged || dependencyChanged) {
          operations.push({
            kind: "provider",
            command: `ado pr update ${pr.id} --target ${branch.base} --depends-on ${dependency ?? "none"}`,
            description: `Update PR !${pr.id} to match ${branch.name} → ${branch.base}`,
            mutating: true,
          });
        }
        if (dependencyChanged && baseBranch) {
          operations.push({
            kind: "provider",
            command: `ado pr link --source ${branch.name} --depends-on ${dependency}`,
            description: `Link PR !${pr.id} to depend on ${basePr ? `PR !${basePr.id}` : baseBranch}`,
            mutating: true,
          });
        }
      }
      basePr = pr;
      baseBranch = branch.name;
    }
    return operations;
  }

  private async applySubmit(stack: Stack): Promise<void> {
    await validateStack(stack, this.deps.git, "submit");
    const operations: PlannedOperation[] = [];
    const created: PullRequest[] = [];
    const updated: PullRequest[] = [];
    const reused: PullRequest[] = [];
    const activeByBranch = activePullRequestsByBranch(
      await this.deps.provider.listPullRequests()
    );
    let basePr: PullRequest | undefined;

    for (const b of [...stack.branches].sort((a, z) => a.level - z.level)) {
      const push = this.deps.git.planPush(b.name, false);
      await this.deps.git.apply(push);
      operations.push(push);

      const dependsOn = basePr ? [basePr.id] : [];
      let pr = activeByBranch.get(b.name);
      let needsDependencyComment = false;
      if (!pr) {
        const description = await this.buildDescription(stack, b, basePr);
        pr = await this.deps.provider.createPullRequest({
          title: titleFor(b),
          description,
          sourceBranch: b.name,
          targetBranch: b.base,
          dependsOn,
        });
        created.push(pr);
        needsDependencyComment = basePr !== undefined;
        await this.deps.store.appendAudit({
          action: "pr.create",
          actor: this.actor,
          stackId: stack.id,
          summary: `Opened PR !${pr.id} for ${b.name} → ${b.base}`,
          details: { prId: pr.id, dependsOn },
          applied: true,
        });
      } else {
        const targetChanged = pr.targetBranch !== b.base;
        const dependencyChanged = !sameNumbers(pr.dependsOn, dependsOn);
        if (targetChanged || dependencyChanged) {
          pr = await this.deps.provider.updatePullRequest(pr.id, {
            targetBranch: b.base,
            dependsOn,
          });
          updated.push(pr);
          needsDependencyComment =
            dependencyChanged && basePr !== undefined;
          await this.deps.store.appendAudit({
            action: "pr.update",
            actor: this.actor,
            stackId: stack.id,
            summary: `Updated PR !${pr.id} to target ${b.base}`,
            details: { prId: pr.id, dependsOn },
            applied: true,
          });
        } else {
          reused.push(pr);
        }
      }

      if (needsDependencyComment && basePr) {
        await this.deps.provider.addComment(
          pr.id,
          `🧩 **StackPilot**: this PR is stacked on !${basePr.id}. Review that one first.`
        );
        await this.deps.store.appendAudit({
          action: "pr.link",
          actor: this.actor,
          stackId: stack.id,
          summary: `Linked PR !${pr.id} to depend on !${basePr.id}`,
          applied: true,
        });
      }

      b.prId = pr.id;
      this.prCache.set(pr.id, pr);
      basePr = pr;
    }

    await this.deps.store.saveStack(stack);
    await this.deps.store.appendAudit({
      action: "stack.submit",
      actor: this.actor,
      stackId: stack.id,
      summary: `Submitted ${stack.name}: ${created.length} created, ${updated.length} updated, ${reused.length} reused`,
      details: { operations: operations.map((op) => op.command) },
      applied: true,
    });
  }

  /** Create PRs for any stacked branch that doesn't yet have one, bottom-up. */
  async createPullRequests(
    stackName: string,
    opts: { draft?: boolean } = {}
  ): Promise<PullRequest[]> {
    const stack = this.requireStack(stackName);
    const created: PullRequest[] = [];

    for (const b of [...stack.branches].sort((a, z) => a.level - z.level)) {
      if (b.prId) continue;
      const basePr = this.basePrOf(stack, b);
      const description = await this.buildDescription(stack, b, basePr);
      const pr = await this.deps.provider.createPullRequest({
        title: titleFor(b),
        description,
        sourceBranch: b.name,
        targetBranch: b.base,
        isDraft: opts.draft ?? false,
        dependsOn: basePr ? [basePr.id] : [],
      });
      b.prId = pr.id;
      this.prCache.set(pr.id, pr);
      created.push(pr);

      await this.deps.store.appendAudit({
        action: "pr.create",
        actor: this.actor,
        stackId: stack.id,
        summary: `Opened PR !${pr.id} for ${b.name} → ${b.base}`,
        details: { prId: pr.id, dependsOn: pr.dependsOn },
        applied: true,
      });

      if (basePr) {
        await this.deps.provider.addComment(
          pr.id,
          `🧩 **StackPilot**: this PR is stacked on !${basePr.id}. Review that one first.`
        );
        await this.deps.store.appendAudit({
          action: "pr.link",
          actor: this.actor,
          stackId: stack.id,
          summary: `Linked PR !${pr.id} to depend on !${basePr.id}`,
          applied: true,
        });
      }
    }
    await this.deps.store.saveStack(stack);
    return created;
  }

  /** (Re)generate AI descriptions for every PR in the stack and update them. */
  async describe(stackName: string, branchName?: string): Promise<PullRequest[]> {
    const stack = this.requireStack(stackName);
    const updated: PullRequest[] = [];
    await this.prsFor(stack); // populate PR cache for dependency linking
    const targets = branchName
      ? stack.branches.filter((b) => b.name === branchName)
      : stack.branches;

    for (const b of targets) {
      if (!b.prId) continue;
      const basePr = this.basePrOf(stack, b);
      const description = await this.buildDescription(stack, b, basePr);
      const pr = await this.deps.provider.updatePullRequest(b.prId, {
        description,
        dependsOn: basePr ? [basePr.id] : [],
      });
      updated.push(pr);
      await this.deps.store.appendAudit({
        action: "ai.describe",
        actor: this.actor,
        stackId: stack.id,
        summary: `AI regenerated description for PR !${pr.id} (${b.name})`,
        applied: true,
      });
    }
    return updated;
  }

  private async buildDescription(
    stack: Stack,
    b: StackedBranch,
    basePr?: PullRequest
  ): Promise<string> {
    const commits = await this.deps.git.commitsBetween(b.base, b.name);
    const changedFiles = await this.deps.git.changedFiles(b.base, b.name);
    return this.deps.ai.describePullRequest({
      stack,
      branch: b,
      commits,
      changedFiles,
      basePr,
    });
  }

  // ---- sync / restack ---------------------------------------------------

  /**
   * Detect branches whose base moved and plan the rebases needed to bring the
   * whole stack back in line. Mutating; honors the approval gate.
   */
  async sync(stackName: string, apply: boolean): Promise<PlanResult> {
    const stack = this.requireStack(stackName);
    await validateStack(stack, this.deps.git, "sync");
    const messages: string[] = [];
    const operations: PlannedOperation[] = [];
    let parentWillMove = false;

    for (const b of [...stack.branches].sort((a, z) => a.level - z.level)) {
      const baseSha = await safeSha(this.deps.git, b.base);
      const oldBaseSha =
        b.lastKnownBaseSha ?? this.baseBranch(stack, b)?.lastKnownSha;
      const baseMoved =
        oldBaseSha !== undefined &&
        baseSha !== undefined &&
        oldBaseSha !== baseSha;
      const needsRebase = baseMoved || parentWillMove;

      if (needsRebase && oldBaseSha) {
        const rebase = this.deps.git.planRebase(
          b.name,
          b.base,
          oldBaseSha
        );
        const push = this.deps.git.planPush(b.name, true);
        operations.push(rebase, push);
        const reason = baseMoved
          ? `${b.base} moved`
          : `${b.base} will be rebased`;
        messages.push(
          `↻ ${b.name}: replay commits after ${shortSha(oldBaseSha)} onto ${b.base} (${reason})`
        );
        parentWillMove = true;
      } else {
        messages.push(`✓ ${b.name} is up to date`);
        parentWillMove = false;
      }
    }

    if (operations.length === 0) {
      return { operations, applied: false, messages };
    }

    return this.runOrGate({
      stack,
      action: "branch.sync",
      description: `Restack ${stack.name} (${operations.length / 2} branch(es))`,
      operations,
      apply,
      messages,
      effect: { kind: "sync", stackId: stack.id },
    });
  }

  // ---- merge ------------------------------------------------------------

  /**
   * Merge the bottom PR, then retarget and restack everything above it so
   * reviewer history on the upper PRs is preserved.
   */
  async merge(stackName: string, apply: boolean): Promise<PlanResult> {
    const stack = this.requireStack(stackName);
    await validateStack(stack, this.deps.git, "merge");
    const ordered = [...stack.branches].sort((a, z) => a.level - z.level);
    const bottom = ordered[0];
    if (!bottom?.prId) {
      throw new Error("Bottom of stack has no PR to merge");
    }

    const operations: PlannedOperation[] = [];
    const messages: string[] = [`Merge bottom PR !${bottom.prId} (${bottom.name}) into ${bottom.base}`];

    for (const b of ordered.slice(1)) {
      const newBase = b.base === bottom.name ? bottom.base : b.base;
      const oldBaseSha =
        b.lastKnownBaseSha ?? this.baseBranch(stack, b)?.lastKnownSha;
      if (!oldBaseSha) {
        throw new Error(`Cannot restack ${b.name}: previous base SHA is unknown`);
      }
      operations.push(this.deps.git.planRebase(b.name, newBase, oldBaseSha));
      operations.push(this.deps.git.planPush(b.name, true));
      messages.push(`Retarget ${b.name} onto ${newBase}`);
    }

    return this.runOrGate({
      stack,
      action: "stack.merge",
      description: `Merge & restack ${stack.name}`,
      operations,
      apply,
      messages,
      effect: {
        kind: "merge",
        stackId: stack.id,
        bottomBranch: bottom.name,
        bottomPrId: bottom.prId,
      },
    });
  }

  /** Apply the semantic state change for an approved/immediate plan. */
  private async applyEffect(effect: StackEffect): Promise<void> {
    if (effect.kind === "submit") {
      await this.applySubmit(this.requireStack(effect.stackId));
      return;
    }

    if (effect.kind === "sync") {
      const stack = this.requireStack(effect.stackId);
      for (const b of stack.branches) {
        const [branchSha, baseSha] = await Promise.all([
          safeSha(this.deps.git, b.name),
          safeSha(this.deps.git, b.base),
        ]);
        b.lastKnownSha = branchSha;
        b.lastKnownBaseSha = baseSha;
      }
      await this.deps.store.saveStack(stack);
      return;
    }

    // merge: complete the bottom PR, drop it, re-level and retarget the rest.
    const stack = this.requireStack(effect.stackId);
    const ordered = [...stack.branches].sort((a, z) => a.level - z.level);
    const bottom = ordered[0];
    const trunkTarget = bottom.base;
    await this.deps.provider.completePullRequest(effect.bottomPrId);
    stack.branches = ordered.slice(1).map((b, i) => ({
      ...b,
      level: i,
      base: i === 0 ? trunkTarget : ordered[i].name,
    }));
    for (const b of stack.branches) {
      const [branchSha, baseSha] = await Promise.all([
        safeSha(this.deps.git, b.name),
        safeSha(this.deps.git, b.base),
      ]);
      b.lastKnownSha = branchSha;
      b.lastKnownBaseSha = baseSha;
    }
    const newBottom = stack.branches[0];
    if (newBottom?.prId) {
      await this.deps.provider.updatePullRequest(newBottom.prId, {
        targetBranch: newBottom.base,
        dependsOn: [],
      });
    }
    await this.deps.store.saveStack(stack);
    await this.deps.store.appendAudit({
      action: "stack.merge",
      actor: this.actor,
      stackId: stack.id,
      summary: `Merged PR !${effect.bottomPrId} and restacked ${stack.branches.length} branch(es)`,
      applied: true,
    });
  }

  // ---- review -----------------------------------------------------------

  async reviewSummary(stackName: string, post: boolean): Promise<string> {
    const stack = this.requireStack(stackName);
    const prs = await this.prsFor(stack);
    const summary = await this.deps.ai.reviewStack({ stack, prs });

    if (post) {
      const bottom = [...stack.branches].sort((a, z) => a.level - z.level)[0];
      if (bottom?.prId) await this.deps.provider.addComment(bottom.prId, summary);
    }
    await this.deps.store.appendAudit({
      action: "review.summary",
      actor: this.actor,
      stackId: stack.id,
      summary: `Generated stack review summary${post ? " and posted to bottom PR" : ""}`,
      applied: post,
    });
    return summary;
  }

  // ---- approvals --------------------------------------------------------

  async approve(approvalId: string): Promise<PlanResult> {
    const req = this.deps.store.getApproval(approvalId);
    if (!req) throw new Error(`Approval ${approvalId} not found`);
    if (req.status !== "pending")
      throw new Error(`Approval ${approvalId} is already ${req.status}`);

    req.status = "approved";
    await this.deps.store.saveApproval(req);
    await this.deps.store.appendAudit({
      action: "approval.grant",
      actor: this.actor,
      stackId: req.stackId,
      summary: `Approved ${req.description}`,
      applied: false,
    });

    await this.applyPlan(req.operations, req.effect);

    if (req.action !== "stack.submit") {
      await this.deps.store.appendAudit({
        action: req.action,
        actor: this.actor,
        stackId: req.stackId,
        summary: `Applied ${req.operations.length} operation(s): ${req.description}`,
        details: { operations: req.operations.map((o) => o.command) },
        applied: true,
      });
    }
    return { operations: req.operations, applied: true, messages: [`Applied: ${req.description}`] };
  }

  async deny(approvalId: string): Promise<void> {
    const req = this.deps.store.getApproval(approvalId);
    if (!req) throw new Error(`Approval ${approvalId} not found`);
    req.status = "denied";
    await this.deps.store.saveApproval(req);
    await this.deps.store.appendAudit({
      action: "approval.deny",
      actor: this.actor,
      stackId: req.stackId,
      summary: `Denied ${req.description}`,
      applied: false,
    });
  }

  // ---- helpers ----------------------------------------------------------

  async validate(stackName: string): Promise<ValidationResult> {
    return validateStack(
      this.requireStack(stackName),
      this.deps.git,
      "validate"
    );
  }

  async navigate(
    stackName: string,
    target: NavigationTarget
  ): Promise<string> {
    const stack = this.requireStack(stackName);
    const ordered = [...stack.branches].sort((a, b) => a.level - b.level);
    const current = await this.deps.git.currentBranch();
    let destination: string;

    switch (target) {
      case "top":
        destination = ordered.at(-1)?.name ?? stack.trunk;
        break;
      case "bottom":
        destination = ordered[0]?.name ?? stack.trunk;
        break;
      case "trunk":
        destination = stack.trunk;
        break;
      case "up": {
        if (current === stack.trunk) {
          destination = ordered[0]?.name ?? stack.trunk;
          break;
        }
        const index = ordered.findIndex((b) => b.name === current);
        if (index < 0) throw new Error(`Branch ${current} is not in stack ${stack.name}`);
        destination = ordered[Math.min(index + 1, ordered.length - 1)].name;
        break;
      }
      case "down": {
        const index = ordered.findIndex((b) => b.name === current);
        if (index < 0) throw new Error(`Branch ${current} is not in stack ${stack.name}`);
        destination = ordered[Math.max(index - 1, 0)].name;
        break;
      }
    }

    if (!(await this.deps.git.branchExists(destination))) {
      throw new Error(`Branch ${destination} does not exist locally`);
    }
    if (destination !== current) {
      await this.deps.git.switchBranch(destination);
    }
    return destination;
  }

  async checkout(branchOrPr: string): Promise<CheckoutResult> {
    const prId = /^\d+$/.test(branchOrPr) ? Number(branchOrPr) : undefined;
    const matches = this.deps.store
      .listStacks()
      .flatMap((stack) =>
        stack.branches
          .filter((branch) =>
            prId === undefined
              ? branch.name === branchOrPr
              : branch.prId === prId
          )
          .map((branch) => ({ stack, branch: branch.name }))
      );

    if (matches.length === 0) {
      throw new Error(
        prId === undefined
          ? `Branch ${branchOrPr} is not part of a local stack`
          : `PR !${prId} is not part of a local stack`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `${branchOrPr} matches multiple local stacks; use a unique branch or PR ID`
      );
    }

    const match = matches[0];
    if (!(await this.deps.git.branchExists(match.branch))) {
      throw new Error(`Branch ${match.branch} does not exist locally`);
    }
    if ((await this.deps.git.currentBranch()) !== match.branch) {
      await this.deps.git.switchBranch(match.branch);
    }
    return match;
  }

  /**
   * Either run mutating operations immediately (when apply=true and approval is
   * not required) or record a pending {@link ApprovalRequest} for later.
   */
  private async runOrGate(args: {
    stack: Stack;
    action: ApprovalRequest["action"];
    description: string;
    operations: PlannedOperation[];
    apply: boolean;
    messages: string[];
    effect: StackEffect;
  }): Promise<PlanResult> {
    const { stack, action, description, operations, apply, messages, effect } = args;

    const needsApproval = this.deps.config.requireApproval;

    if (!apply) {
      return { operations, applied: false, messages: [...messages, "(dry run — pass --apply to execute)"] };
    }

    if (needsApproval) {
      const req: ApprovalRequest = {
        id: randomUUID(),
        stackId: stack.id,
        action,
        description,
        operations,
        effect,
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      await this.deps.store.saveApproval(req);
      await this.deps.store.appendAudit({
        action: "approval.request",
        actor: this.actor,
        stackId: stack.id,
        summary: `Requested approval: ${description}`,
        details: { approvalId: req.id, operations: operations.map((o) => o.command) },
        applied: false,
      });
      return {
        operations,
        applied: false,
        approval: req,
        messages: [...messages, `Approval required. Run: stackpilot approve ${req.id}`],
      };
    }

    await this.applyPlan(operations, effect);
    if (action !== "stack.submit") {
      await this.deps.store.appendAudit({
        action,
        actor: this.actor,
        stackId: stack.id,
        summary: `Applied: ${description}`,
        details: { operations: operations.map((o) => o.command) },
        applied: true,
      });
    }
    return { operations, applied: true, messages: [...messages, `Applied: ${description}`] };
  }

  private async applyPlan(
    operations: PlannedOperation[],
    effect?: StackEffect
  ): Promise<void> {
    if (effect?.kind === "submit") {
      await this.applyEffect(effect);
      return;
    }
    for (const op of operations) await this.deps.git.apply(op);
    if (effect) await this.applyEffect(effect);
  }

  requireStack(nameOrId: string): Stack {
    const stack = this.deps.store.getStack(nameOrId);
    if (!stack) throw new Error(`Stack "${nameOrId}" not found`);
    return stack;
  }

  private baseBranch(stack: Stack, b: StackedBranch): StackedBranch | undefined {
    return stack.branches.find((x) => x.name === b.base);
  }

  private basePrOf(stack: Stack, b: StackedBranch): PullRequest | undefined {
    const base = this.baseBranch(stack, b);
    if (!base?.prId) return undefined;
    // Synchronous view is enough for linking; details are fetched on demand.
    return this.prCache.get(base.prId);
  }

  private prCache = new Map<number, PullRequest>();

  async prsFor(stack: Stack): Promise<PullRequest[]> {
    const prs: PullRequest[] = [];
    for (const b of stack.branches) {
      if (!b.prId) continue;
      const pr = await this.deps.provider.getPullRequest(b.prId);
      if (pr) {
        this.prCache.set(pr.id, pr);
        prs.push(pr);
      }
    }
    return prs;
  }
}

function topBranch(stack: Stack): StackedBranch {
  return [...stack.branches].sort((a, b) => b.level - a.level)[0];
}

function titleFor(b: StackedBranch): string {
  const tail = b.name.split("/").pop() ?? b.name;
  return tail.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function activePullRequestsByBranch(
  prs: PullRequest[]
): Map<string, PullRequest> {
  const active = new Map<string, PullRequest>();
  for (const pr of prs) {
    if (pr.status !== "active" && pr.status !== "draft") continue;
    if (active.has(pr.sourceBranch)) {
      throw new Error(
        `Multiple active PRs found for branch ${pr.sourceBranch}`
      );
    }
    active.set(pr.sourceBranch, pr);
  }
  return active;
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

async function safeSha(git: GitService, branch: string): Promise<string | undefined> {
  try {
    return await git.headSha(branch);
  } catch {
    return undefined;
  }
}
