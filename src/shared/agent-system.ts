export interface AgentSystemTaskStatus {
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
}

export interface AgentSystemAgentStatus {
  id: string;
  label: string;
  state: string;
  active: boolean;
  roles: string[];
  pending: number;
  awaitingAck: number;
  lastSeenAt: number | null;
}

export interface AgentSystemStatus {
  runId: string;
  planId: string | null;
  managerAgentId: string;
  runStatus: 'RUNNING' | 'RUN_VERIFIED';
  progress: { verified: number; total: number };
  tasks: AgentSystemTaskStatus[];
  agents: AgentSystemAgentStatus[];
}
