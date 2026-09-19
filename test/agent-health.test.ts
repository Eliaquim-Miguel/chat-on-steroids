import { describe, expect, it } from 'vitest';
import { AGENT_DETACHED_RECOVERY_GRACE_MS, collectAgentHealthEvidence, evaluateAgentHealth } from '../src/main/agent-health.js';
import type { AgentHealthEvidence, AgentHealthInput } from '../src/shared/agent-health.js';
import type { AgentInfo, AgentState } from '../src/shared/session.js';

const NOW = 2_000_000_000;

function broker(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'worker-1',
    role: 'worker',
    label: 'Health worker',
    task: 'test health projection',
    reasoningEffort: null,
    model: null,
    state: 'active',
    createdAt: NOW - 10_000,
    activatedAt: NOW - 9_000,
    finishedAt: null,
    result: null,
    pending: 0,
    awaitingAck: 0,
    delivered: 0,
    conversationId: 'chat-worker-1',
    detachedAt: null,
    lastSeenAt: NOW - 1_000,
    revivable: true,
    sleptAt: null,
    contextTokens: 100,
    ...overrides
  };
}

function evidence(overrides: Partial<AgentHealthEvidence> = {}): AgentHealthEvidence {
  return {
    identity: 'exact',
    browserPresent: true,
    runningToolCalls: 0,
    generating: false,
    activeTurnId: false,
    workflowBlocked: false,
    finiteWait: null,
    ...overrides
  };
}

function input(evidenceOverrides: Partial<AgentHealthEvidence> = {}, brokerOverrides: Partial<AgentInfo> = {}): AgentHealthInput {
  return { id: brokerOverrides.id ?? 'worker-1', broker: broker(brokerOverrides), evidence: evidence(evidenceOverrides) };
}

function state(value: AgentState): Partial<AgentInfo> { return { state: value }; }

describe('agent health projection', () => {
  it('composes exact evidence only when identity matches', () => {
    const b = broker();
    expect(collectAgentHealthEvidence({
      id: b.id, broker: b,
      browser: { agentId: b.id, conversationId: b.conversationId!, browserPresent: true, generating: true, activeTurnId: true, finiteWait: null },
      runningToolCalls: 2, transfer: null, workflowBlocked: false
    })).toMatchObject({ identity: 'exact', browserPresent: true, runningToolCalls: 2, generating: true, activeTurnId: true });
  });

  it('fails closed on conflicting browser identity', () => {
    const b = broker();
    expect(collectAgentHealthEvidence({
      id: b.id, broker: b,
      browser: { agentId: b.id, conversationId: 'other-chat', browserPresent: true, generating: false, activeTurnId: false, finiteWait: null },
      runningToolCalls: 0, transfer: null, workflowBlocked: false
    }).identity).toBe('conflict');
  });

  it('prioritizes in-flight MCP work', () => {
    expect(evaluateAgentHealth(input({ runningToolCalls: 1, generating: true }), NOW)).toMatchObject({
      activity: 'tool_call', health: 'healthy', recommendedAction: 'none'
    });
  });

  it('keeps an open turn healthy despite missing browser presence', () => {
    expect(evaluateAgentHealth(input({ generating: true, browserPresent: false }, { lastSeenAt: NOW - 60 * 60_000 }), NOW))
      .toMatchObject({ activity: 'working', health: 'healthy' });
  });

  it('keeps a freshly detached worker observation-only inside the recovery grace', () => {
    expect(evaluateAgentHealth(input({ browserPresent: false }, { state: 'detached', detachedAt: NOW - 1_000 }), NOW))
      .toMatchObject({ health: 'degraded', recommendedAction: 'observe' });
  });

  it('promotes an exactly attributed long-detached worker to safe restart recovery', () => {
    expect(evaluateAgentHealth(input(
      { browserPresent: false },
      { state: 'detached', detachedAt: NOW - AGENT_DETACHED_RECOVERY_GRACE_MS - 1 }
    ), NOW)).toMatchObject({ health: 'stalled', recommendedAction: 'restart' });
  });

  it('keeps sleeping and terminal states healthy', () => {
    expect(evaluateAgentHealth(input({}, state('sleeping')), NOW)).toMatchObject({ activity: 'sleeping', health: 'healthy' });
    expect(evaluateAgentHealth(input({}, state('finished')), NOW)).toMatchObject({ activity: 'done', health: 'healthy' });
    expect(evaluateAgentHealth(input({}, state('failed')), NOW)).toMatchObject({ activity: 'done', health: 'healthy' });
  });

  it('fails closed when exact identity is missing', () => {
    expect(evaluateAgentHealth(input({ identity: 'missing' }), NOW)).toMatchObject({ health: 'unknown', recommendedAction: 'observe' });
  });

  it('gives workflow blockers precedence', () => {
    expect(evaluateAgentHealth(input({ workflowBlocked: true, identity: 'missing' }), NOW))
      .toMatchObject({ health: 'blocked', recommendedAction: 'user_attention' });
  });

  it('stalls only an expired non-exempt finite wait', () => {
    expect(evaluateAgentHealth(input({ finiteWait: {
      kind: 'delivery', startedAt: NOW - 90_001, deadlineMs: 90_000, exempt: false, recommendedAction: 'retry_delivery'
    }}), NOW)).toMatchObject({ health: 'stalled', recommendedAction: 'retry_delivery' });
    expect(evaluateAgentHealth(input({ finiteWait: {
      kind: 'transfer', startedAt: NOW - 20 * 60_000, deadlineMs: 10 * 60_000, exempt: true, recommendedAction: 'observe'
    }}), NOW)).toMatchObject({ health: 'healthy' });
  });

  it('does not mutate broker state', () => {
    const b = broker({ pending: 2, awaitingAck: 1 });
    const before = structuredClone(b);
    evaluateAgentHealth({ id: b.id, broker: b, evidence: evidence() }, NOW);
    expect(b).toEqual(before);
  });
});
