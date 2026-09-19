import { AgentError, PRIME_ID, agentConversation, statusForCaller, type Caller } from '../agents.js';
import { managerRuntimeForRun } from './manager-authority.js';
import { recoverOrchestrationState } from './recovery.js';
import { workflowStateForRun } from './workflow.js';

export interface AgentSystemStatus {
  runId: string;
  planId: string | null;
  managerAgentId: string;
  runStatus: 'RUNNING' | 'RUN_VERIFIED';
  progress: { verified: number; total: number };
  tasks: Array<{
    id: string;
    title: string;
    state: string;
    dependencies: string[];
    assignedWorkerId: string | null;
    reviewerId: string | null;
    reviewRound: number;
    riskClass: 'normal' | 'high';
    worktree: { id: string; branch: string; virtualPath: string } | null;
    verification: { total: number; passed: number; failed: number };
  }>;
  agents: Array<{
    id: string;
    label: string;
    state: string;
    active: boolean;
    roles: string[];
    pending: number;
    awaitingAck: number;
    lastSeenAt: number | null;
  }>;
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

  const workflow = await workflowStateForRun(runId);
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

  const agents = broker.state.agents.map((agent) => {
    const roles = new Set<string>([agent.role]);
    if (agent.id === managerAgentId) roles.add('manager');
    for (const task of tasks) {
      if (task.assignedWorkerId === agent.id) roles.add('worker');
      if (task.reviewerId === agent.id) roles.add('reviewer');
    }
    const active = ['invited', 'active', 'detached', 'waking'].includes(agent.state);
    return {
      id: agent.id,
      label: agent.label,
      state: agent.state,
      active,
      roles: [...roles],
      pending: agent.pending,
      awaitingAck: agent.awaitingAck,
      lastSeenAt: agent.lastSeenAt
    };
  });

  return {
    runId,
    planId: recovered.state.managerPlanId,
    managerAgentId,
    runStatus: recovered.state.runStatus,
    progress: {
      verified: tasks.filter((task) => task.state === 'VERIFIED').length,
      total: tasks.length
    },
    tasks,
    agents
  };
}
