import type { AgentSystemStatus } from '../shared/agent-system.js';

export interface AgentHealthRecoveryResult {
  agentId: string;
  conversationId: string;
  outcome: 'queued' | 'pending' | 'refused';
}

export type AgentHealthRecoveryRequest = (conversationId: string) => Promise<'queued' | 'pending' | 'refused'>;

/**
 * Automatic recovery is deliberately narrower than health detection:
 * only exact stalled workers whose projection recommends a retry/restart may trigger the
 * existing browser-repair owner. Unknown/degraded/blocked evidence remains observation-only.
 */
export async function recoverStalledAgents(
  status: AgentSystemStatus,
  request?: AgentHealthRecoveryRequest
): Promise<AgentHealthRecoveryResult[]> {
  const recover = request ?? (async (conversationId: string) => {
    const { requestAgentHealthRecovery } = await import('./bridge.js');
    return requestAgentHealthRecovery(conversationId);
  });
  const results: AgentHealthRecoveryResult[] = [];
  for (const agent of status.agents) {
    if (
      agent.health !== 'stalled' ||
      (agent.recommendedAction !== 'wake' && agent.recommendedAction !== 'retry_delivery') ||
      !agent.conversationId ||
      !agent.roles.includes('worker')
    ) continue;
    results.push({
      agentId: agent.id,
      conversationId: agent.conversationId,
      outcome: await recover(agent.conversationId)
    });
  }
  return results;
}

export function startAgentHealthRecovery(options: {
  intervalMs?: number;
  onError?: (error: Error) => void;
} = {}): () => void {
  const intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const { agentSystemStatusForUi } = await import('./orchestration/status.js');
      const status = await agentSystemStatusForUi();
      if (status?.recoveryPolicy === 'safe') await recoverStalledAgents(status);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
