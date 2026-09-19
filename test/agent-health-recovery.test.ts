import { describe, expect, it, vi } from 'vitest';
import { recoverStalledAgents } from '../src/main/agent-health-recovery.js';
import type { AgentSystemStatus } from '../src/shared/agent-system.js';

function status(): AgentSystemStatus {
  return {
    observedAt: Date.now(),
    recoveryPolicy: 'safe',
    runId: 'run-one',
    planId: 'plan-one',
    managerAgentId: 'worker-1',
    runStatus: 'RUNNING',
    progress: { verified: 0, total: 1 },
    tasks: [],
    agents: [
      {
        id: 'worker-1', label: 'stalled', state: 'detached', active: true,
        conversationId: 'conversation-one', activity: 'waiting', health: 'stalled',
        recommendedAction: 'restart', healthReason: 'detached beyond recovery grace',
        roles: ['worker', 'manager'], pending: 0, awaitingAck: 0, lastSeenAt: Date.now() - 60_000
      },
      {
        id: 'worker-2', label: 'degraded', state: 'detached', active: true,
        conversationId: 'conversation-two', activity: 'waiting', health: 'degraded',
        recommendedAction: 'observe', healthReason: 'still inside grace',
        roles: ['worker'], pending: 0, awaitingAck: 0, lastSeenAt: Date.now()
      }
    ]
  };
}

describe('safe agent health recovery', () => {
  it('requests recovery only for exact stalled worker projections that recommend retry/restart', async () => {
    const request = vi.fn(async () => 'queued' as const);
    await expect(recoverStalledAgents(status(), request)).resolves.toEqual([
      { agentId: 'worker-1', conversationId: 'conversation-one', outcome: 'queued' }
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('conversation-one');
  });

  it('never turns blocked/user-attention evidence into automatic browser action', async () => {
    const value = status();
    value.agents[0] = { ...value.agents[0]!, health: 'blocked', recommendedAction: 'user_attention' };
    const request = vi.fn(async () => 'queued' as const);
    await expect(recoverStalledAgents(value, request)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
