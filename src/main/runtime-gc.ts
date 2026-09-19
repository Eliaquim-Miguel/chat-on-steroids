import { agentInfoForOwnedConversation } from './agents.js';
import { unifiedExecManager } from './codex/manager.js';
import { execOwner, forgetExecOwner } from './codex/ownership.js';
import type {
  ConditionalTerminationResult,
  ManagedProcessRuntimeInfo
} from './codex/unified-exec.js';
import { getSession } from './session/store.js';
import type { AgentInfo } from '../shared/session.js';

export const AGENT_RUNTIME_RETENTION_MS = 30 * 60_000;
export const AGENT_RUNTIME_SWEEP_MS = 30_000;

export interface RuntimeGcDependencies {
  listRuntimeProcesses(): ManagedProcessRuntimeInfo[];
  execOwner(processId: number): string | null;
  forgetExecOwner(processId: number): void;
  conversationForPrincipal(principal: string): Promise<string | null>;
  agentInfoForOwnedConversation(conversationId: string): AgentInfo | null;
  terminateProcessIfUnusedSince(processId: number, cutoff: number): Promise<ConditionalTerminationResult>;
  terminateProcess(processId: number): Promise<boolean>;
}

export interface RuntimeGcSummary {
  checked: number;
  eligible: number;
  terminated: number;
  exited: number;
  missing: number;
  busy: number;
  recent: number;
  unowned: number;
  unresolved: number;
  ineligible: number;
  changed: number;
}

const defaultDependencies: RuntimeGcDependencies = {
  listRuntimeProcesses: () => unifiedExecManager.listRuntimeProcesses(),
  execOwner,
  forgetExecOwner,
  conversationForPrincipal: async (principal) => {
    // Current COS owns terminal sessions by durable local session principal, not ChatGPT
    // conversation id. Temporary request principals deliberately fail closed here.
    if (principal.startsWith('request:')) return null;
    return (await getSession(principal))?.conversationId ?? null;
  },
  agentInfoForOwnedConversation,
  terminateProcessIfUnusedSince: (processId, cutoff) =>
    unifiedExecManager.terminateProcessIfUnusedSince(processId, cutoff),
  terminateProcess: (processId) => unifiedExecManager.terminateProcess(processId)
};

export interface AgentRuntimeReleaseTarget {
  processId: number;
  principal: string;
  conversationId: string;
}

export interface RuntimeReleaseSummary {
  checked: number;
  terminated: number;
  missing: number;
  changed: number;
}

function emptySummary(): RuntimeGcSummary {
  return {
    checked: 0,
    eligible: 0,
    terminated: 0,
    exited: 0,
    missing: 0,
    busy: 0,
    recent: 0,
    unowned: 0,
    unresolved: 0,
    ineligible: 0,
    changed: 0
  };
}

function collectibleWorker(info: AgentInfo | null, conversationId: string, cutoff: number): boolean {
  return Boolean(
    info &&
      info.role === 'worker' &&
      info.state === 'sleeping' &&
      info.revivable &&
      info.conversationId === conversationId &&
      info.sleptAt !== null &&
      info.sleptAt <= cutoff
  );
}

export async function sweepAgentRuntimeGc(
  now = Date.now(),
  dependencies: RuntimeGcDependencies = defaultDependencies
): Promise<RuntimeGcSummary> {
  const cutoff = now - AGENT_RUNTIME_RETENTION_MS;
  const summary = emptySummary();

  for (const runtime of dependencies.listRuntimeProcesses()) {
    summary.checked += 1;
    const principal = dependencies.execOwner(runtime.processId);
    if (!principal) {
      summary.unowned += 1;
      continue;
    }

    const conversationId = await dependencies.conversationForPrincipal(principal);
    if (!conversationId) {
      summary.unresolved += 1;
      continue;
    }
    if (!collectibleWorker(dependencies.agentInfoForOwnedConversation(conversationId), conversationId, cutoff)) {
      summary.ineligible += 1;
      continue;
    }

    const currentPrincipal = dependencies.execOwner(runtime.processId);
    if (currentPrincipal !== principal) {
      summary.changed += 1;
      continue;
    }
    const currentConversationId = await dependencies.conversationForPrincipal(currentPrincipal);
    if (
      currentConversationId !== conversationId ||
      !collectibleWorker(dependencies.agentInfoForOwnedConversation(conversationId), conversationId, cutoff)
    ) {
      summary.changed += 1;
      continue;
    }

    summary.eligible += 1;
    const result = await dependencies.terminateProcessIfUnusedSince(runtime.processId, cutoff);
    summary[result] += 1;

    // Terminated normally drops ownership through UnifiedExec's release listener. Missing may
    // leave a stale registry row, so clean it only if nobody acquired that numeric id. Exited
    // intentionally keeps ownership because current COS retains unread completed output.
    if ((result === 'terminated' || result === 'missing') && dependencies.execOwner(runtime.processId) === principal) {
      dependencies.forgetExecOwner(runtime.processId);
    }
  }

  return summary;
}

export async function captureAgentRuntimeTargets(
  conversationIds?: ReadonlySet<string>,
  dependencies: RuntimeGcDependencies = defaultDependencies
): Promise<AgentRuntimeReleaseTarget[]> {
  const targets: AgentRuntimeReleaseTarget[] = [];
  for (const runtime of dependencies.listRuntimeProcesses()) {
    const principal = dependencies.execOwner(runtime.processId);
    if (!principal) continue;
    const conversationId = await dependencies.conversationForPrincipal(principal);
    if (!conversationId) continue;
    if (conversationIds && !conversationIds.has(conversationId)) continue;
    if (!dependencies.agentInfoForOwnedConversation(conversationId)) continue;
    targets.push({ processId: runtime.processId, principal, conversationId });
  }
  return targets;
}

export async function releaseCapturedAgentRuntimeTargets(
  targets: readonly AgentRuntimeReleaseTarget[],
  dependencies: RuntimeGcDependencies = defaultDependencies
): Promise<RuntimeReleaseSummary> {
  const summary: RuntimeReleaseSummary = { checked: 0, terminated: 0, missing: 0, changed: 0 };
  for (const target of targets) {
    summary.checked += 1;
    if (dependencies.execOwner(target.processId) !== target.principal) {
      summary.changed += 1;
      continue;
    }

    const terminated = await dependencies.terminateProcess(target.processId);
    summary[terminated ? 'terminated' : 'missing'] += 1;

    if (dependencies.execOwner(target.processId) === target.principal) {
      dependencies.forgetExecOwner(target.processId);
    }
  }
  return summary;
}

export interface StartAgentRuntimeGcOptions {
  onError?: (error: Error) => void;
  sweep?: () => Promise<unknown>;
}

export function startAgentRuntimeGc(options: StartAgentRuntimeGcOptions = {}): () => void {
  const sweep = options.sweep ?? (() => sweepAgentRuntimeGc());
  let inFlight = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void Promise.resolve()
      .then(() => sweep())
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        inFlight = false;
      });
  }, AGENT_RUNTIME_SWEEP_MS);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
