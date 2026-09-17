import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { MockAIProvider } from "../src/ai/mockAi.js";
import { parseComment } from "../src/cli/commentCommands.js";
import { buildContext } from "../src/cli/context.js";
import { renderStackJson } from "../src/cli/render.js";
import { StackManager } from "../src/core/stackManager.js";
import type { StackPilotConfig } from "../src/core/types.js";
import { MockGitService, RealGitService } from "../src/git/gitService.js";
import {
  embedDependsOn,
  parseDependsOn,
  stripDependsOn,
} from "../src/providers/ado/adoProvider.js";
import { MockProvider } from "../src/providers/mock/mockProvider.js";
import { StackStore } from "../src/store/stackStore.js";

const execFileAsync = promisify(execFile);

async function makeEngine(root: string) {
  await rm(join(root, ".stackpilot"), { recursive: true, force: true });
  const store = new StackStore(root);
  await store.load();
  const config: StackPilotConfig = {
    provider: "mock",
    ai: "mock",
    trunk: "main",
    repository: "test-repo",
    requireApproval: false,
    actor: "tester",
  };
  await store.setConfig(config);
  const provider = new MockProvider({ branches: ["main"] });
  const git = new MockGitService();
  const engine = new StackManager({
    provider,
    git,
    ai: new MockAIProvider(),
    store,
    config,
  });
  return { engine, git, provider, store };
}

test("dependsOn marker round-trips through a description", () => {
  const desc = "Some PR body.";
  const embedded = embedDependsOn(desc, [101, 102]);
  assert.deepEqual(parseDependsOn(embedded), [101, 102]);
  assert.equal(stripDependsOn(embedded), "Some PR body.");
  // Re-embedding does not duplicate the marker.
  const reembedded = embedDependsOn(embedded, [103]);
  assert.deepEqual(parseDependsOn(reembedded), [103]);
  assert.equal((reembedded.match(/stackpilot:depends-on/g) ?? []).length, 1);
});

test("parseComment recognises triggers and verbs", () => {
  assert.deepEqual(parseComment("/stackpilot sync now")?.verb, "sync");
  assert.deepEqual(parseComment("/sp status")?.verb, "status");
  assert.deepEqual(parseComment("@stackpilot review")?.verb, "review");
  assert.equal(parseComment("just a normal comment"), undefined);
});

test("stack status JSON is ordered and machine-readable", async () => {
  const { engine } = await makeEngine(
    join(tmpdir(), "stackpilot-test-status-json")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");
  await engine.submit("s", true);

  const stack = engine.requireStack("s");
  const output = JSON.parse(
    renderStackJson(stack, await engine.prsFor(stack))
  );

  assert.equal(output.name, "s");
  assert.equal(output.trunk, "main");
  assert.deepEqual(
    output.branches.map(
      (branch: {
        name: string;
        targetBranch: string;
        prId: number;
        status: string;
        dependsOn: number[];
      }) => ({
        name: branch.name,
        targetBranch: branch.targetBranch,
        prId: branch.prId,
        status: branch.status,
        dependsOn: branch.dependsOn,
      })
    ),
    [
      {
        name: "a",
        targetBranch: "main",
        prId: 101,
        status: "active",
        dependsOn: [],
      },
      {
        name: "b",
        targetBranch: "a",
        prId: 102,
        status: "active",
        dependsOn: [101],
      },
      {
        name: "c",
        targetBranch: "b",
        prId: 103,
        status: "active",
        dependsOn: [102],
      },
    ]
  );
});

test("stack status JSON represents branches without PRs", async () => {
  const { engine } = await makeEngine(
    join(tmpdir(), "stackpilot-test-status-json-no-pr")
  );
  await engine.createStack("s", "main", "a");
  const stack = engine.requireStack("s");

  const output = JSON.parse(renderStackJson(stack, []));

  assert.deepEqual(output.branches[0], {
    level: 0,
    name: "a",
    targetBranch: "main",
    prId: null,
    status: "not_created",
    dependsOn: [],
  });
});

test("PRs are created bottom-up with dependency links", async () => {
  const { engine } = await makeEngine(join(tmpdir(), "stackpilot-test-deps"));
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");
  const prs = await engine.createPullRequests("s");
  assert.equal(prs.length, 3);
  // bottom has no deps; each upper depends on the one below.
  assert.deepEqual(prs[0].dependsOn, []);
  assert.deepEqual(prs[1].dependsOn, [prs[0].id]);
  assert.deepEqual(prs[2].dependsOn, [prs[1].id]);
  assert.equal(prs[0].targetBranch, "main");
  assert.equal(prs[1].targetBranch, "a");
});

test("submit reuses existing PRs and creates only missing PRs", async () => {
  const { engine, git, provider } = await makeEngine(
    join(tmpdir(), "stackpilot-test-submit")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");
  const first = await provider.createPullRequest({
    title: "A",
    description: "",
    sourceBranch: "a",
    targetBranch: "main",
    dependsOn: [],
  });
  await provider.createPullRequest({
    title: "B",
    description: "",
    sourceBranch: "b",
    targetBranch: "a",
    dependsOn: [first.id],
  });

  const result = await engine.submit("s", true);
  const prs = await provider.listPullRequests();

  assert.equal(result.applied, true);
  assert.equal(prs.length, 3);
  assert.deepEqual(
    git.applied.map((op) => op.command),
    [
      "git push origin a",
      "git push origin b",
      "git push origin c",
    ]
  );
  assert.equal(provider.comments.length, 1);
  assert.equal(
    provider.comments[0].prId,
    prs.find((pr) => pr.sourceBranch === "c")?.id
  );
});

test("submit corrects PR links without duplicating PRs or comments", async () => {
  const { engine, provider } = await makeEngine(
    join(tmpdir(), "stackpilot-test-submit-idempotent")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  const first = await provider.createPullRequest({
    title: "A",
    description: "",
    sourceBranch: "a",
    targetBranch: "wrong-base",
    dependsOn: [999],
  });
  const second = await provider.createPullRequest({
    title: "B",
    description: "",
    sourceBranch: "b",
    targetBranch: "main",
    dependsOn: [],
  });

  const firstRun = await engine.submit("s", true);
  const secondRun = await engine.submit("s", true);
  const prs = await provider.listPullRequests();

  assert.equal(firstRun.applied, true);
  assert.equal(secondRun.applied, true);
  assert.equal(prs.length, 2);
  assert.equal(provider.comments.length, 1);
  assert.equal(prs.find((pr) => pr.id === first.id)?.targetBranch, "main");
  assert.deepEqual(prs.find((pr) => pr.id === first.id)?.dependsOn, []);
  assert.equal(prs.find((pr) => pr.id === second.id)?.targetBranch, "a");
  assert.deepEqual(prs.find((pr) => pr.id === second.id)?.dependsOn, [
    first.id,
  ]);
});

test("submit rejects a branch that does not contain its parent", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-invalid-ancestry")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  git.setAncestor("a", "b", false);

  await assert.rejects(
    engine.submit("s", true),
    /b does not contain a in its history/
  );
  assert.equal(git.applied.length, 0);
});

test("validation rejects missing branches and merge commits", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-invalid-history")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  git.deleteBranch("b");
  await assert.rejects(engine.submit("s", true), /Branch b does not exist locally/);

  git.setSha("b", "b-v1");
  git.setMergeCommits("a", "b", ["merge-1"]);
  await assert.rejects(
    engine.submit("s", true),
    /b contains 1 merge commit/
  );
});

test("sync and merge require a clean working tree and no active rebase", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-git-preflight")
  );
  await engine.createStack("s", "main", "a");
  git.setDirty(true);
  await assert.rejects(engine.sync("s", false), /uncommitted changes/);
  await assert.rejects(engine.merge("s", false), /uncommitted changes/);

  git.setDirty(false);
  git.setRebaseInProgress(true);
  await assert.rejects(engine.submit("s", true), /rebase is already in progress/);
});

test("validate reports each successful stack safety check", async () => {
  const { engine } = await makeEngine(
    join(tmpdir(), "stackpilot-test-validate-report")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");

  const result = await engine.validate("s");

  assert.deepEqual(result.checks, [
    "No Git rebase is in progress",
    "Working tree is clean",
    "All branches exist",
    "a contains main",
    "b contains a",
    "Stack history is linear",
  ]);
});

test("real Git dirty check ignores StackPilot state only", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-real-git-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, ".stackpilot"));
  await writeFile(join(root, ".stackpilot", "state.json"), "{}");
  const git = new RealGitService(root);

  assert.equal(await git.hasUncommittedChanges(), false);

  await writeFile(join(root, "user-change.txt"), "change");
  assert.equal(await git.hasUncommittedChanges(), true);
});

test("offline context restores mock branches from persisted stack state", async () => {
  const root = join(tmpdir(), "stackpilot-test-persisted-mock-git");
  const { engine } = await makeEngine(root);
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");

  const restored = await buildContext(root);
  const result = await restored.engine.validate("s");

  assert.ok(result.checks.includes("All branches exist"));
  assert.equal(await restored.git.branchExists("main"), true);
  assert.equal(await restored.git.branchExists("a"), true);
  assert.equal(await restored.git.branchExists("b"), true);
});

test("navigation switches between ordered stack branches", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-navigation")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");

  assert.equal(await engine.navigate("s", "bottom"), "a");
  assert.equal(await engine.navigate("s", "up"), "b");
  assert.equal(await engine.navigate("s", "top"), "c");
  assert.equal(await engine.navigate("s", "up"), "c");
  assert.equal(await engine.navigate("s", "down"), "b");
  assert.equal(await engine.navigate("s", "trunk"), "main");
  assert.equal(await git.currentBranch(), "main");
});

test("checkout discovers a local stack by branch or PR ID", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-checkout")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.submit("s", true);

  const byBranch = await engine.checkout("b");
  assert.equal(byBranch.stack.name, "s");
  assert.equal(byBranch.branch, "b");
  assert.equal(await git.currentBranch(), "b");

  const byPr = await engine.checkout("101");
  assert.equal(byPr.stack.name, "s");
  assert.equal(byPr.branch, "a");
  assert.equal(await git.currentBranch(), "a");
});

test("checkout reports missing and ambiguous local stack matches", async () => {
  const { engine } = await makeEngine(
    join(tmpdir(), "stackpilot-test-checkout-errors")
  );
  await engine.createStack("first", "main", "shared");
  await engine.createStack("second", "main", "other");
  await engine.push("second", "shared");

  await assert.rejects(
    engine.checkout("missing"),
    /Branch missing is not part of a local stack/
  );
  await assert.rejects(
    engine.checkout("999"),
    /PR !999 is not part of a local stack/
  );
  await assert.rejects(
    engine.checkout("shared"),
    /matches multiple local stacks/
  );
});

test("merge completes the bottom PR and restacks the rest onto trunk", async () => {
  const root = join(tmpdir(), "stackpilot-test-merge");
  const { engine, git, provider } = await makeEngine(root);
  git.setSha("main", "main-v1");
  git.setSha("a", "a-v1");
  git.setSha("b", "b-v1");
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.createPullRequests("s");
  const result = await engine.merge("s", true);
  assert.equal(result.applied, true);
  assert.deepEqual(
    result.operations.map((op) => op.command),
    [
      "git rebase --onto main a-v1 b",
      "git push --force-with-lease origin b",
    ]
  );

  const stack = engine.requireStack("s");
  assert.equal(stack.branches.length, 1);
  assert.equal(stack.branches[0].name, "b");
  assert.equal(stack.branches[0].base, "main");
  assert.equal(stack.branches[0].lastKnownBaseSha, "main-v1");

  const prs = await provider.listPullRequests();
  const bottom = prs.find((p) => p.sourceBranch === "a");
  const upper = prs.find((p) => p.sourceBranch === "b");
  assert.equal(bottom?.status, "completed");
  assert.equal(upper?.targetBranch, "main");
  assert.deepEqual(upper?.dependsOn, []);
});

test("merge restacks every remaining branch onto its updated parent", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-merge-cascade")
  );
  git.setSha("main", "main-v1");
  git.setSha("a", "a-v1");
  git.setSha("b", "b-v1");
  git.setSha("c", "c-v1");
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");
  await engine.createPullRequests("s");

  const result = await engine.merge("s", true);

  assert.deepEqual(
    result.operations.map((op) => op.command),
    [
      "git rebase --onto main a-v1 b",
      "git push --force-with-lease origin b",
      "git rebase --onto b b-v1 c",
      "git push --force-with-lease origin c",
    ]
  );
});

test("approval gate defers mutating sync until approved", async () => {
  const root = join(tmpdir(), "stackpilot-test-approval");
  await rm(join(root, ".stackpilot"), { recursive: true, force: true });
  const store = new StackStore(root);
  await store.load();
  const config: StackPilotConfig = {
    provider: "mock",
    ai: "mock",
    trunk: "main",
    requireApproval: true,
    actor: "tester",
  };
  await store.setConfig(config);
  const git = new MockGitService();
  const engine = new StackManager({
    provider: new MockProvider(),
    git,
    ai: new MockAIProvider(),
    store,
    config,
  });
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.createPullRequests("s");
  git.bumpSha("a");

  const plan = await engine.sync("s", true);
  assert.equal(plan.applied, false);
  assert.ok(plan.approval, "a pending approval should be created");
  assert.equal(git.applied.length, 0, "no git ops before approval");

  await engine.approve(plan.approval!.id);
  assert.ok(git.applied.length > 0, "git ops run after approval");
  assert.equal(store.listApprovals("approved").length, 1);
});

test("approval gate defers all submit mutations until approved", async () => {
  const root = join(tmpdir(), "stackpilot-test-submit-approval");
  await rm(join(root, ".stackpilot"), { recursive: true, force: true });
  const store = new StackStore(root);
  await store.load();
  const config: StackPilotConfig = {
    provider: "mock",
    ai: "mock",
    trunk: "main",
    requireApproval: true,
    actor: "tester",
  };
  await store.setConfig(config);
  const git = new MockGitService();
  const provider = new MockProvider();
  const engine = new StackManager({
    provider,
    git,
    ai: new MockAIProvider(),
    store,
    config,
  });
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await provider.createPullRequest({
    title: "B",
    description: "",
    sourceBranch: "b",
    targetBranch: "wrong-base",
    dependsOn: [999],
  });
  const providerStateBeforeSubmit = await provider.listPullRequests();

  const dryRun = await engine.submit("s", false);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.approval, undefined);
  assert.equal(git.applied.length, 0);
  assert.deepEqual(
    await provider.listPullRequests(),
    providerStateBeforeSubmit
  );
  assert.equal(provider.comments.length, 0);

  const plan = await engine.submit("s", true);
  assert.equal(plan.applied, false);
  assert.ok(plan.approval);
  assert.equal(git.applied.length, 0);
  assert.deepEqual(
    await provider.listPullRequests(),
    providerStateBeforeSubmit
  );
  assert.equal(provider.comments.length, 0);
  assert.ok(
    plan.operations.some(
      (operation) =>
        operation.kind === "provider" &&
        operation.command ===
          "ado pr link --source b --depends-on a"
    )
  );

  await engine.approve(plan.approval!.id);
  assert.deepEqual(
    git.applied.map((operation) => operation.command),
    ["git push origin a", "git push origin b"]
  );
  const prs = await provider.listPullRequests();
  assert.equal(prs.length, 2);
  const basePr = prs.find((pr) => pr.sourceBranch === "a");
  const upperPr = prs.find((pr) => pr.sourceBranch === "b");
  assert.ok(basePr);
  assert.ok(upperPr);
  assert.equal(upperPr.targetBranch, "a");
  assert.deepEqual(upperPr.dependsOn, [basePr.id]);
  assert.equal(provider.comments.length, 1);
});

test("sync rebases from the recorded base SHA when trunk moves", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-trunk-rebase")
  );
  git.setSha("main", "main-v1");
  git.setSha("a", "a-v1");
  git.setSha("b", "b-v1");
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");

  git.setSha("main", "main-v2");
  const plan = await engine.sync("s", false);

  assert.deepEqual(plan.messages, [
    "↻ a: replay commits after main-v1 onto main (main moved)",
    "↻ b: replay commits after a-v1 onto a (a will be rebased)",
    "(dry run — pass --apply to execute)",
  ]);
  assert.deepEqual(
    plan.operations.map((op) => op.command),
    [
      "git rebase --onto main main-v1 a",
      "git push --force-with-lease origin a",
      "git rebase --onto a a-v1 b",
      "git push --force-with-lease origin b",
    ]
  );
});

test("sync cascades upward when a lower stack branch moves", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-cascade-rebase")
  );
  git.setSha("main", "main-v1");
  git.setSha("a", "a-v1");
  git.setSha("b", "b-v1");
  git.setSha("c", "c-v1");
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");

  git.setSha("a", "a-v2");
  const plan = await engine.sync("s", false);

  assert.deepEqual(
    plan.operations.map((op) => op.command),
    [
      "git rebase --onto a a-v1 b",
      "git push --force-with-lease origin b",
      "git rebase --onto b b-v1 c",
      "git push --force-with-lease origin c",
    ]
  );
});
