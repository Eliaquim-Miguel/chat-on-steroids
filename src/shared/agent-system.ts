import type { AgentActivity, AgentHealth, AgentHealthRecommendedAction } from './agent-health.js';
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
  conversationId: string | null;
  state: string;
  active: boolean;
  activity: AgentActivity;
  health: AgentHealth;
  recommendedAction: AgentHealthRecommendedAction;
  healthReason: string;
  roles: string[];
  pending: number;
  awaitingAck: number;
  lastSeenAt: number | null;
}

export interface AgentSystemStatus {
  observedAt: number;
  recoveryPolicy: 'safe';
  runId: string;
  planId: string | null;
  managerAgentId: string;
  runStatus: 'RUNNING' | 'RUN_VERIFIED';
  progress: { verified: number; total: number };
  tasks: AgentSystemTaskStatus[];
  agents: AgentSystemAgentStatus[];
}
