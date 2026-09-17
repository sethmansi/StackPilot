import { join } from "node:path";
import { MockAIProvider } from "../ai/mockAi.js";
import type { AIProvider } from "../ai/aiProvider.js";
import { StackManager } from "../core/stackManager.js";
import type { StackPilotConfig } from "../core/types.js";
import { MockGitService, RealGitService } from "../git/gitService.js";
import type { GitService } from "../git/gitService.js";
import { AdoProvider } from "../providers/ado/adoProvider.js";
import { MockProvider } from "../providers/mock/mockProvider.js";
import type { Provider } from "../providers/provider.js";
import { StackStore } from "../store/stackStore.js";

export interface EngineContext {
  engine: StackManager;
  provider: Provider;
  git: GitService;
  ai: AIProvider;
  store: StackStore;
  config: StackPilotConfig;
}

export const DEFAULT_CONFIG: StackPilotConfig = {
  provider: "mock",
  ai: "mock",
  trunk: "main",
  requireApproval: true,
  actor: process.env.USERNAME ?? process.env.USER ?? "stackpilot-user",
};

/**
 * Build a fully-wired engine from persisted config, selecting real or mock
 * adapters. Real ADO needs AZURE_DEVOPS_PAT; falls back to mock when absent so
 * the tool always runs.
 */
export async function buildContext(root = process.cwd()): Promise<EngineContext> {
  const store = new StackStore(root);
  await store.load();
  const config = store.getConfig() ?? DEFAULT_CONFIG;

  const provider = createProvider(config, root);
  const git = createGit(config, store);
  const ai = createAI(config);

  const engine = new StackManager({ provider, git, ai, store, config });
  return { engine, provider, git, ai, store, config };
}

function createProvider(config: StackPilotConfig, root: string): Provider {
  const pat = process.env.AZURE_DEVOPS_PAT ?? process.env.AZURE_DEVOPS_EXT_PAT;
  if (
    config.provider === "ado" &&
    pat &&
    config.organizationUrl &&
    config.project &&
    config.repository
  ) {
    return new AdoProvider({
      organizationUrl: config.organizationUrl,
      project: config.project,
      repository: config.repository,
      pat,
    });
  }
  return new MockProvider({
    branches: [config.trunk],
    persistFile: join(root, ".stackpilot", "mock-provider.json"),
  });
}

function createGit(config: StackPilotConfig, store: StackStore): GitService {
  if (config.provider === "ado") {
    try {
      return new RealGitService();
    } catch {
      return new MockGitService();
    }
  }
  return new MockGitService({ branchShas: persistedMockShas(store) });
}

function persistedMockShas(store: StackStore): Record<string, string> {
  const shas: Record<string, string> = {};
  for (const stack of store.listStacks()) {
    for (const branch of stack.branches) {
      if (branch.lastKnownSha) shas[branch.name] = branch.lastKnownSha;
      if (branch.lastKnownBaseSha && !shas[branch.base]) {
        shas[branch.base] = branch.lastKnownBaseSha;
      }
    }
  }
  return shas;
}

function createAI(_config: StackPilotConfig): AIProvider {
  // Only the deterministic mock is wired for the prototype; the interface lets a
  // real LLM adapter drop in without engine changes.
  return new MockAIProvider();
}
