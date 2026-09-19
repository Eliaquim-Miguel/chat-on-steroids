import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentState } from '../src/shared/session.js';
import type { ManagedProcessRuntimeInfo, ConditionalTerminationResult } from '../src/main/codex/unified-exec.js';
import {
  AGENT_RUNTIME_RETENTION_MS,
  AGENT_RUNTIME_SWEEP_MS,
  captureAgentRuntimeTargets,
  releaseCapturedAgentRuntimeTargets,
  startAgentRuntimeGc,
  sweepAgentRuntimeGc,
  type RuntimeGcDependencies
} from '../src/main/runtime-gc.js';

const NOW = 2_000_000_000;
const OLD = NOW - AGENT_RUNTIME_RETENTION_MS - 1;

function workerInfo(
  state: AgentState = 'sleeping',
  options: { revivable?: boolean; sleptAt?: number | null; role?: 'worker' | 'prime'; conversationId?: string } = {}
): AgentInfo {
  return {
    id: options.role === 'prime' ? 'prime' : 'worker-1',
    role: options.role ?? 'worker',
    label: 'GC worker',
    task: 'test runtime gc',
    reasoningEffort: null,
    model: null,
    state,
    createdAt: OLD - 1_000,
    activatedAt: OLD - 500,
    finishedAt: null,
    result: null,
    pending: 0,
    awaitingAck: 0,
    delivered: 0,
    conversationId: options.conversationId ?? 'chat-worker',
    detachedAt: null,
    lastSeenAt: OLD,
    revivable: options.revivable ?? true,
    sleptAt: options.sleptAt === undefined ? OLD : options.sleptAt,
    contextTokens: 100
  };
}

function runtime(processId = 101, lastUsed = OLD): ManagedProcessRuntimeInfo {
  return {
    processId,
    command: 'npm run dev',
    cwd: '/repo',
    pid: 1_001,
    tty: true,
    lastUsed,
    initialExecCommandActive: false
  };
}

function deps(options: {
  processes?: ManagedProcessRuntimeInfo[];
  principals?: Array<string | null>;
  conversations?: Array<string | null>;
  agents?: Array<AgentInfo | null>;
  termination?: ConditionalTerminationResult;
  explicitTermination?: boolean;
} = {}): RuntimeGcDependencies & {
  terminateProcessIfUnusedSince: ReturnType<typeof vi.fn>;
  terminateProcess: ReturnType<typeof vi.fn>;
  forgetExecOwner: ReturnType<typeof vi.fn>;
} {
  const principals = [...(options.principals ?? ['session-worker'])];
  const conversations = [...(options.conversations ?? ['chat-worker'])];
  const agents = [...(options.agents ?? [workerInfo()])];
  let lastPrincipal = principals.at(-1) ?? null;
  let lastConversation = conversations.at(-1) ?? null;
  let lastAgent = agents.at(-1) ?? null;
  const execOwner = vi.fn(() => {
    if (principals.length > 0) lastPrincipal = principals.shift() ?? null;
    return lastPrincipal;
  });
  const conversationForPrincipal = vi.fn(async () => {
    if (conversations.length > 0) lastConversation = conversations.shift() ?? null;
    return lastConversation;
  });
  const agentInfoForOwnedConversation = vi.fn(() => {
    if (agents.length > 0) lastAgent = agents.shift() ?? null;
    return lastAgent;
  });
  const terminateProcessIfUnusedSince = vi.fn(async () => options.termination ?? 'terminated');
  const terminateProcess = vi.fn(async () => options.explicitTermination ?? true);
  const forgetExecOwner = vi.fn();
  return {
    listRuntimeProcesses: () => options.processes ?? [runtime()],
    execOwner,
    forgetExecOwner,
    conversationForPrincipal,
    agentInfoForOwnedConversation,
    terminateProcessIfUnusedSince,
    terminateProcess
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('agent runtime garbage collection', () => {
  it('terminates an old runtime only after its session principal resolves to an old sleeping worker', async () => {
    const fake = deps();
    const summary = await sweepAgentRuntimeGc(NOW, fake);
    expect(fake.terminateProcessIfUnusedSince).toHaveBeenCalledWith(101, NOW - AGENT_RUNTIME_RETENTION_MS);
    expect(summary.terminated).toBe(1);
  });

  it('never terminates an unknown or unresolved principal', async () => {
    const unowned = deps({ principals: [null] });
    expect((await sweepAgentRuntimeGc(NOW, unowned)).unowned).toBe(1);
    expect(unowned.terminateProcessIfUnusedSince).not.toHaveBeenCalled();

    const requestOwned = deps({ principals: ['request:abc'], conversations: [null] });
    expect((await sweepAgentRuntimeGc(NOW, requestOwned)).unresolved).toBe(1);
    expect(requestOwned.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
  });

  it.each<AgentState>(['active', 'detached', 'waking', 'invited', 'failed', 'finished'])(
    'never periodically terminates a %s worker runtime',
    async (state) => {
      const fake = deps({ agents: [workerInfo(state)] });
      await sweepAgentRuntimeGc(NOW, fake);
      expect(fake.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
    }
  );

  it('never terminates a prime, non-revivable worker, or recent sleeper', async () => {
    for (const agent of [
      workerInfo('sleeping', { role: 'prime' }),
      workerInfo('sleeping', { revivable: false }),
      workerInfo('sleeping', { sleptAt: NOW - AGENT_RUNTIME_RETENTION_MS + 1 })
    ]) {
      const fake = deps({ agents: [agent] });
      await sweepAgentRuntimeGc(NOW, fake);
      expect(fake.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
    }
  });

  it('rechecks principal and lifecycle immediately before termination', async () => {
    const moved = deps({ principals: ['session-worker', 'session-other'] });
    await sweepAgentRuntimeGc(NOW, moved);
    expect(moved.terminateProcessIfUnusedSince).not.toHaveBeenCalled();

    const woke = deps({ agents: [workerInfo(), workerInfo('waking')] });
    await sweepAgentRuntimeGc(NOW, woke);
    expect(woke.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
  });

  it.each<ConditionalTerminationResult>(['recent', 'busy', 'exited'])(
    'keeps ownership when conditional termination reports %s',
    async (termination) => {
      const fake = deps({ termination });
      const summary = await sweepAgentRuntimeGc(NOW, fake);
      expect(fake.forgetExecOwner).not.toHaveBeenCalled();
      expect(summary[termination]).toBe(1);
    }
  );

  it('forgets only a still-stale owner after a missing runtime', async () => {
    const fake = deps({ termination: 'missing', principals: ['session-worker', 'session-worker', 'session-worker'] });
    await sweepAgentRuntimeGc(NOW, fake);
    expect(fake.forgetExecOwner).toHaveBeenCalledWith(101);
  });

  it('captures live runtimes by exact conversation while retaining their session principal', async () => {
    const fake = deps({
      processes: [runtime(101), runtime(202)],
      principals: ['session-worker', 'session-other'],
      conversations: ['chat-worker', 'chat-other'],
      agents: [workerInfo(), null]
    });
    await expect(captureAgentRuntimeTargets(new Set(['chat-worker']), fake)).resolves.toEqual([
      { processId: 101, principal: 'session-worker', conversationId: 'chat-worker' }
    ]);
  });

  it('explicit release rechecks the principal before terminating', async () => {
    const fake = deps({ principals: ['session-other'] });
    const summary = await releaseCapturedAgentRuntimeTargets(
      [{ processId: 101, principal: 'session-worker', conversationId: 'chat-worker' }],
      fake
    );
    expect(fake.terminateProcess).not.toHaveBeenCalled();
    expect(summary.changed).toBe(1);
  });

  it('runs every 30 seconds without overlapping and can be stopped', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sweep = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    const stop = startAgentRuntimeGc({ sweep: sweep as () => Promise<unknown> });

    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_SWEEP_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_SWEEP_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_SWEEP_MS);
    expect(sweep).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_SWEEP_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
