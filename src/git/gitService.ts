import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PlannedOperation } from "../core/types.js";

const execFileAsync = promisify(execFile);

/**
 * Controlled Git surface. Every mutating method returns a {@link PlannedOperation}
 * describing exactly what will run, so the engine can preview/approve before
 * anything touches the working tree or remote.
 */
export interface GitService {
  readonly name: string;
  currentBranch(): Promise<string>;
  headSha(branch?: string): Promise<string>;
  branchExists(branch: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  mergeCommitsBetween(base: string, head: string): Promise<string[]>;
  hasUncommittedChanges(): Promise<boolean>;
  isRebaseInProgress(): Promise<boolean>;
  switchBranch(branch: string): Promise<void>;
  /** Commit subjects present on `head` but not on `base`. */
  commitsBetween(base: string, head: string): Promise<string[]>;
  /** File paths changed on `head` relative to `base`. */
  changedFiles(base: string, head: string): Promise<string[]>;

  planCreateBranch(name: string, from: string): PlannedOperation;
  planRebase(branch: string, onto: string, from: string): PlannedOperation;
  planPush(branch: string, force: boolean): PlannedOperation;

  /** Execute a previously planned operation. */
  apply(op: PlannedOperation): Promise<void>;
}

/** Real git backed by the `git` CLI in the current working directory. */
export class RealGitService implements GitService {
  readonly name = "git";
  constructor(private readonly cwd: string = process.cwd()) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: this.cwd });
    return stdout.trim();
  }

  async currentBranch(): Promise<string> {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  async headSha(branch = "HEAD"): Promise<string> {
    return this.git(["rev-parse", branch]);
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch (error) {
      if (hasExitCode(error, 1)) return false;
      throw error;
    }
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (hasExitCode(error, 1)) return false;
      throw error;
    }
  }

  async mergeCommitsBetween(base: string, head: string): Promise<string[]> {
    const out = await this.git(["rev-list", "--merges", `${base}..${head}`]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.git([
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude).stackpilot",
      ":(exclude).stackpilot/**",
    ]);
    return status.length > 0;
  }

  async isRebaseInProgress(): Promise<boolean> {
    const [mergePath, applyPath] = await Promise.all([
      this.git(["rev-parse", "--git-path", "rebase-merge"]),
      this.git(["rev-parse", "--git-path", "rebase-apply"]),
    ]);
    return (
      existsSync(resolve(this.cwd, mergePath)) ||
      existsSync(resolve(this.cwd, applyPath))
    );
  }

  async switchBranch(branch: string): Promise<void> {
    await this.git(["switch", branch]);
  }

  async commitsBetween(base: string, head: string): Promise<string[]> {
    const out = await this.git([
      "log",
      "--format=%s",
      `${base}..${head}`,
    ]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  async changedFiles(base: string, head: string): Promise<string[]> {
    const out = await this.git(["diff", "--name-only", `${base}...${head}`]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  planCreateBranch(name: string, from: string): PlannedOperation {
    return {
      kind: "git",
      command: `git checkout -b ${name} ${from}`,
      description: `Create branch ${name} from ${from}`,
      mutating: true,
    };
  }

  planRebase(branch: string, onto: string, from: string): PlannedOperation {
    return {
      kind: "git",
      command: `git rebase --onto ${onto} ${from} ${branch}`,
      description: `Rebase ${branch} onto ${onto} (was based on ${from})`,
      mutating: true,
    };
  }

  planPush(branch: string, force: boolean): PlannedOperation {
    const flag = force ? " --force-with-lease" : "";
    return {
      kind: "git",
      command: `git push${flag} origin ${branch}`,
      description: `Push ${branch} to origin${force ? " (force-with-lease)" : ""}`,
      mutating: true,
    };
  }

  async apply(op: PlannedOperation): Promise<void> {
    if (op.kind !== "git") return;
    const args = op.command.replace(/^git\s+/, "").split(/\s+/);
    await this.git(args);
  }
}

/**
 * Simulated git for offline demos. Generates plausible commits/files from branch
 * names and records applied operations instead of touching a real repository.
 */
export class MockGitService implements GitService {
  readonly name = "mock-git";
  readonly applied: PlannedOperation[] = [];
  private current = "main";
  private shas = new Map<string, string>();
  private invalidAncestry = new Set<string>();
  private mergeCommits = new Map<string, string[]>();
  private dirty = false;
  private rebasing = false;

  constructor(private readonly seed?: {
    branchCommits?: Record<string, string[]>;
    branchFiles?: Record<string, string[]>;
    branchShas?: Record<string, string>;
  }) {
    for (const [branch, sha] of Object.entries(seed?.branchShas ?? {})) {
      this.shas.set(branch, sha);
    }
  }

  setCurrent(branch: string): void {
    this.current = branch;
  }

  async currentBranch(): Promise<string> {
    return this.current;
  }

  async headSha(branch = this.current): Promise<string> {
    if (!this.shas.has(branch)) {
      this.shas.set(branch, randomSha());
    }
    return this.shas.get(branch)!;
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.shas.has(branch);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return !this.invalidAncestry.has(`${ancestor}\0${descendant}`);
  }

  async mergeCommitsBetween(base: string, head: string): Promise<string[]> {
    return this.mergeCommits.get(`${base}\0${head}`) ?? [];
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return this.dirty;
  }

  async isRebaseInProgress(): Promise<boolean> {
    return this.rebasing;
  }

  async switchBranch(branch: string): Promise<void> {
    if (!(await this.branchExists(branch))) {
      throw new Error(`Branch ${branch} does not exist`);
    }
    this.current = branch;
  }

  /** Force a new SHA for a branch to simulate upstream drift. */
  bumpSha(branch: string): void {
    this.shas.set(branch, randomSha());
  }

  /** Set a predictable SHA for tests and demos. */
  setSha(branch: string, sha: string): void {
    this.shas.set(branch, sha);
  }

  deleteBranch(branch: string): void {
    this.shas.delete(branch);
  }

  setAncestor(
    ancestor: string,
    descendant: string,
    isAncestor: boolean
  ): void {
    const key = `${ancestor}\0${descendant}`;
    if (isAncestor) this.invalidAncestry.delete(key);
    else this.invalidAncestry.add(key);
  }

  setMergeCommits(base: string, head: string, commits: string[]): void {
    this.mergeCommits.set(`${base}\0${head}`, commits);
  }

  setDirty(dirty: boolean): void {
    this.dirty = dirty;
  }

  setRebaseInProgress(rebasing: boolean): void {
    this.rebasing = rebasing;
  }

  async commitsBetween(_base: string, head: string): Promise<string[]> {
    return this.seed?.branchCommits?.[head] ?? [];
  }

  async changedFiles(_base: string, head: string): Promise<string[]> {
    return this.seed?.branchFiles?.[head] ?? [];
  }

  planCreateBranch(name: string, from: string): PlannedOperation {
    return {
      kind: "git",
      command: `git checkout -b ${name} ${from}`,
      description: `Create branch ${name} from ${from}`,
      mutating: true,
    };
  }

  planRebase(branch: string, onto: string, from: string): PlannedOperation {
    return {
      kind: "git",
      command: `git rebase --onto ${onto} ${from} ${branch}`,
      description: `Rebase ${branch} onto ${onto} (was based on ${from})`,
      mutating: true,
    };
  }

  planPush(branch: string, force: boolean): PlannedOperation {
    return {
      kind: "git",
      command: `git push${force ? " --force-with-lease" : ""} origin ${branch}`,
      description: `Push ${branch} to origin`,
      mutating: true,
    };
  }

  async apply(op: PlannedOperation): Promise<void> {
    this.applied.push(op);
  }
}

function randomSha(): string {
  return Array.from({ length: 40 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)]
  ).join("");
}

function hasExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
