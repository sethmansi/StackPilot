/**
 * StackPilot core domain types.
 *
 * A "stack" is an ordered list of dependent branches, each targeting the one
 * below it. Every branch maps to a pull request; the PR chain mirrors the branch
 * chain so reviewers see small, dependent changes instead of one giant diff.
 */

export type PullRequestStatus = "draft" | "active" | "completed" | "abandoned";

export type AuditAction =
  | "stack.create"
  | "stack.push"
  | "stack.pop"
  | "stack.submit"
  | "pr.create"
  | "pr.update"
  | "pr.link"
  | "branch.sync"
  | "branch.restack"
  | "stack.merge"
  | "comment.command"
  | "ai.describe"
  | "review.summary"
  | "approval.request"
  | "approval.grant"
  | "approval.deny";

/** A single pull request as seen by StackPilot (provider-agnostic). */
export interface PullRequest {
  id: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  status: PullRequestStatus;
  url: string;
  /** IDs of PRs this PR depends on (its base in the stack). */
  dependsOn: number[];
  createdAt: string;
  updatedAt: string;
}

/** A branch participating in a stack, with its optional PR. */
export interface StackedBranch {
  /** Position in the stack; 0 is the bottom (closest to the trunk). */
  level: number;
  name: string;
  /** The branch this one is stacked on top of (its merge target). */
  base: string;
  prId?: number;
  /** Last commit SHA StackPilot recorded for drift detection. */
  lastKnownSha?: string;
  /** Commit SHA of `base` when this branch was last synchronized. */
  lastKnownBaseSha?: string;
}

/** Full stack definition persisted by StackPilot. */
export interface Stack {
  id: string;
  name: string;
  /** The trunk/integration branch the bottom of the stack targets. */
  trunk: string;
  branches: StackedBranch[];
  createdAt: string;
  updatedAt: string;
  repository: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: AuditAction;
  actor: string;
  stackId?: string;
  summary: string;
  details?: Record<string, unknown>;
  /** Whether the action mutated remote/git state or was a dry run. */
  applied: boolean;
}

/** A pending operation that requires explicit human approval before running. */
export interface ApprovalRequest {
  id: string;
  stackId: string;
  action: AuditAction;
  description: string;
  /** Git/provider operations that will run once approved. */
  operations: PlannedOperation[];
  /** Semantic state change to apply after the git operations succeed. */
  effect?: StackEffect;
  createdAt: string;
  status: "pending" | "approved" | "denied";
}

/**
 * A recomputable description of the state change an approved plan performs.
 * Stored (instead of a closure) so a plan can be approved in a later process.
 */
export type StackEffect =
  | { kind: "sync"; stackId: string }
  | { kind: "submit"; stackId: string }
  | { kind: "merge"; stackId: string; bottomBranch: string; bottomPrId: number };

/** A concrete, previewable operation produced by the engine before execution. */
export interface PlannedOperation {
  kind: "git" | "provider";
  command: string;
  description: string;
  /** True when the operation writes to remote/local state. */
  mutating: boolean;
}

export interface StackPilotConfig {
  provider: "mock" | "ado";
  ai: "mock" | "openai" | "azure-openai";
  organizationUrl?: string;
  project?: string;
  repository?: string;
  trunk: string;
  /** Require explicit approval before any mutating git/provider operation. */
  requireApproval: boolean;
  actor: string;
}
