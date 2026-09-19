import { AgentError, PRIME_ID, agentConversation, statusForCaller, type Caller, type CallerSwarmStatus } from '../agents.js';
import { collectAgentHealthEvidence, evaluateAgentHealth } from '../agent-health.js';
import { runningToolCalls } from '../mcp/call-context.js';
import { liveConversations } from '../session/recorder.js';
import type { AgentSystemStatus } from '../../shared/agent-system.js';
import { managerRuntimeForRun } from './manager-authority.js';
import { recoverOrchestrationState } from './recovery.js';
import { workflowStateForRun } from './workflow.js';

async function projectStatus(
  runId: string,
  managerAgentId: string,
  broker: CallerSwarmStatus
): Promise<AgentSystemStatus> {
  const recovered = await recoverOrchestrationState();
  if (recovered.state.runId !== runId || recovered.state.managerAgentId !== managerAgentId) {
    throw new AgentError('CONTROL_CENTER_RUN_CHANGED: orchestration authority changed while status was being read.');
  }
  const workflow = await workflowStateForRun(runId);
  const observedAt = Date.now();
  const tasks = Object.values(recovered.state.tasks).map((task) => {
    const wt = task.worktreeId ? recovered.state.worktrees[task.worktreeId] : null;
    const verification = workflow?.verifications?.[task.taskId] ?? [];
    return {
      id: task.taskId,
      title: task.title,
      state: task.state,
      dependencies: [...task.dependencies],
      assignedWorkerId: task.assignedWorkerId,
      reviewerId: task.reviewerId,
      reviewRound: task.reviewRound,
      riskClass: task.riskClass,
      worktree: wt ? { id: wt.worktreeId, branch: wt.branch, virtualPath: wt.virtualPath } : null,
      verification: {
        total: verification.length,
        passed: verification.filter((entry) => entry.passed).length,
        failed: verification.filter((entry) => !entry.passed).length
      }
    };
  });

  const blockedAgentIds = new Set<string>();
  for (const task of tasks) {
    if (task.state !== 'BLOCKED' && task.state !== 'FAILED') continue;
    if (task.assignedWorkerId) blockedAgentIds.add(task.assignedWorkerId);
    if (task.reviewerId) blockedAgentIds.add(task.reviewerId);
  }
  if (workflow?.status === 'blocked') blockedAgentIds.add(managerAgentId);

  const liveByConversation = new Map(liveConversations().map((entry) => [entry.conversationId, entry]));
  const agents = broker.state.agents.map((agent) => {
    const roles = new Set<string>([agent.role]);
    if (agent.id === managerAgentId) roles.add('manager');
    for (const task of tasks) {
      if (task.assignedWorkerId === agent.id) roles.add('worker');
      if (task.reviewerId === agent.id) roles.add('reviewer');
    }

    const live = agent.conversationId ? liveByConversation.get(agent.conversationId) ?? null : null;
    const evidence = collectAgentHealthEvidence({
      id: agent.id,
      broker: agent,
      browser: agent.conversationId
        ? {
            agentId: agent.id,
            conversationId: agent.conversationId,
            browserPresent: agent.state === 'detached' ? false : null,
            generating: live?.generating ?? false,
            activeTurnId: Boolean(live?.activeTurnId),
            finiteWait: null
          }
        : null,
      runningToolCalls: agent.conversationId ? runningToolCalls(agent.conversationId) : 0,
      transfer: null,
      workflowBlocked: blockedAgentIds.has(agent.id)
    });
    const projected = evaluateAgentHealth({ id: agent.id, broker: agent, evidence }, observedAt);

    return {
      id: agent.id,
      label: agent.label,
      state: agent.state,
      active: ['invited', 'active', 'detached', 'waking'].includes(agent.state),
      activity: projected.activity,
      health: projected.health,
      recommendedAction: projected.recommendedAction,
      healthReason: projected.reason,
      roles: [...roles],
      pending: agent.pending,
      awaitingAck: agent.awaitingAck,
      lastSeenAt: agent.lastSeenAt
    };
  });

  return {
    observedAt,
    recoveryPolicy: 'off',
    runId,
    planId: recovered.state.managerPlanId,
    managerAgentId,
    runStatus: recovered.state.runStatus,
    progress: { verified: tasks.filter((task) => task.state === 'VERIFIED').length, total: tasks.length },
    tasks,
    agents
  };
}

export async function agentSystemStatusForCaller(caller: Caller): Promise<AgentSystemStatus> {
  const broker = statusForCaller(caller);
  if (!broker.self) throw new AgentError('CONTROL_CENTER_IDENTITY_LOST: caller is not a member of an agent family.');

  const recovered = await recoverOrchestrationState();
  const runId = recovered.state.runId;
  const managerAgentId = recovered.state.managerAgentId;
  if (!runId || !managerAgentId) {
    throw new AgentError('CONTROL_CENTER_INACTIVE: no Agent System 3.0 run has been created yet.');
  }

  const runtime = await managerRuntimeForRun(runId);
  if (!runtime) throw new AgentError('CONTROL_CENTER_AUTHORITY_LOST: Manager authority is unavailable.');
  const primeConversationId = agentConversation(PRIME_ID, broker.runId ?? undefined);
  if (!primeConversationId || primeConversationId !== runtime.ownerPrimeConversationId) {
    throw new AgentError('CONTROL_CENTER_DENIED: this agent family does not own the active Agent System 3.0 run.');
  }
  return projectStatus(runId, managerAgentId, broker);
}

/** Local renderer projection. It resolves the durable owner itself; no model-supplied identity participates. */
export async function agentSystemStatusForUi(): Promise<AgentSystemStatus | null> {
  const recovered = await recoverOrchestrationState();
  const runId = recovered.state.runId;
  const managerAgentId = recovered.state.managerAgentId;
  if (!runId || !managerAgentId) return null;
  const runtime = await managerRuntimeForRun(runId);
  if (!runtime) return null;
  const broker = statusForCaller({ conversationId: runtime.ownerPrimeConversationId });
  if (!broker.self || broker.self.id !== PRIME_ID) return null;
  return projectStatus(runId, managerAgentId, broker);
}

export type { AgentSystemStatus } from '../../shared/agent-system.js';
