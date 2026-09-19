import { randomUUID } from 'node:crypto';

import { readDurable, writeDurableNow } from './durable.js';
import { goalObjectiveFor, goalSwitchFor, setGoalObjectiveNow, setGoalSwitchNow } from './goal.js';
import { cancelInput, enqueueInput, listInputs } from './session/input.js';
import { getSession } from './session/store.js';

const EXECUTION_STATE = 'autonomous-executions';
const EXECUTION_VERSION = 1 as const;
const MAX_EXECUTIONS = 64;
const MAX_EXECUTION_PLAN_CHARS = 12_000;
const MAX_EXECUTION_TITLE_CHARS = 160;

export type ExecutionMode = 'standard' | 'infinite';
export type ExecutionStatus = 'starting' | 'running' | 'paused' | 'stopped' | 'failed' | 'completed';

type PendingInputKind = 'opening' | 'resume';

export interface ExecutionRun {
  id: string;
  title: string;
  plan: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  sessionId: string | null;
  pendingInputId: string | null;
  pendingInputKind: PendingInputKind | null;
  pendingInputDueAt: number | null;
  lastConversationId: string | null;
  rollovers: number;
  createdAt: number;
  updatedAt: number;
  pausedAt: number | null;
  stoppedAt: number | null;
  completedAt: number | null;
  lastError: string | null;
}

interface ExecutionSnapshot {
  version: typeof EXECUTION_VERSION;
  runs: ExecutionRun[];
}

export interface ExecutionView extends ExecutionRun {
  conversationId: string | null;
  activeTurnId: string | null;
  automation: { enabled: boolean; mode: 'goal' | 'loop'; afterTurn: boolean } | null;
  objective: string;
  pendingInputState: string | null;
}

let loaded = false;
const runs = new Map<string, ExecutionRun>();
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function executionObjective(run: Pick<ExecutionRun, 'plan' | 'mode'>): string {
  if (run.mode === 'standard') {
    return [
      'Complete and verify this approved autonomous execution end-to-end. Stay inside the approved task scope.',
      run.plan
    ].join('\n\n');
  }
  return [
    'Complete and verify the approved task below. After its current milestone is genuinely complete, continue in Loop mode with the next highest-value improvement that stays inside the same project and task intent.',
    'Do not invent unrelated product scope, publish/deploy externally, change credentials/billing, or perform destructive work unless the approved task already authorizes it. Prefer verified maintenance, tests, correctness, reliability, and unfinished requirements.',
    run.plan
  ].join('\n\n');
}

function executionBootstrapText(run: ExecutionRun): string {
  return [
    `Autonomous execution ${run.id} is starting in ${run.mode} mode.`,
    'Carry out the approved objective now. Use the current COS Goal/Loop, agent, plan, tool, test, and Compact & Resume mechanisms normally; do not wait for another user message while approved work remains.',
    run.mode === 'infinite'
      ? 'When one milestone is verified complete, Loop may choose the next highest-value in-scope improvement and continue. Keep every continuation inside the objective and safety boundaries.'
      : 'When the approved objective is verified complete, stop instead of inventing more work.',
    'If a chat is compacted or replaced, continue through the same durable COS session. Preserve evidence of validation and do not duplicate already-completed work.'
  ].join('\n\n');
}

function executionResumeText(run: ExecutionRun): string {
  return [
    `Resume autonomous execution ${run.id}.`,
    'Continue from the durable session state and the approved objective. Re-check what is already complete before changing anything, then continue the remaining work and verification.',
    run.mode === 'infinite'
      ? 'Keep Loop active after verified milestones and choose only the next highest-value in-scope improvement.'
      : 'Stop after the approved objective is verified complete.'
  ].join('\n\n');
}

function validRun(raw: unknown): ExecutionRun | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<ExecutionRun>;
  if (
    typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 80 ||
    typeof value.title !== 'string' || value.title.length > MAX_EXECUTION_TITLE_CHARS ||
    typeof value.plan !== 'string' || value.plan.length < 1 || value.plan.length > MAX_EXECUTION_PLAN_CHARS ||
    (value.mode !== 'standard' && value.mode !== 'infinite') ||
    !['starting', 'running', 'paused', 'stopped', 'failed', 'completed'].includes(value.status as string) ||
    typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
  ) return null;
  const nullableString = (input: unknown): input is string | null => input === null || (typeof input === 'string' && input.length > 0 && input.length <= 256);
  const nullableNumber = (input: unknown): input is number | null => input === null || (typeof input === 'number' && Number.isFinite(input) && input >= 0);
  if (!nullableString(value.sessionId) || !nullableString(value.pendingInputId) || !nullableString(value.lastConversationId)) return null;
  if (!nullableNumber(value.pendingInputDueAt) || !nullableNumber(value.pausedAt) || !nullableNumber(value.stoppedAt) || !nullableNumber(value.completedAt)) return null;
  if (value.pendingInputKind !== null && value.pendingInputKind !== 'opening' && value.pendingInputKind !== 'resume') return null;
  if (typeof value.rollovers !== 'number' || !Number.isInteger(value.rollovers) || value.rollovers < 0) return null;
  if (value.lastError !== null && typeof value.lastError !== 'string') return null;
  return {
    id: value.id,
    title: value.title,
    plan: value.plan,
    mode: value.mode,
    status: value.status as ExecutionStatus,
    sessionId: value.sessionId,
    pendingInputId: value.pendingInputId,
    pendingInputKind: value.pendingInputKind,
    pendingInputDueAt: value.pendingInputDueAt,
    lastConversationId: value.lastConversationId,
    rollovers: value.rollovers,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    pausedAt: value.pausedAt,
    stoppedAt: value.stoppedAt,
    completedAt: value.completedAt,
    lastError: value.lastError === null ? null : value.lastError.slice(0, 500)
  };
}

async function load(): Promise<void> {
  if (loaded) return;
  const saved = await readDurable<unknown>(EXECUTION_STATE);
  runs.clear();
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    const snapshot = saved as Partial<ExecutionSnapshot>;
    if (snapshot.version === EXECUTION_VERSION && Array.isArray(snapshot.runs)) {
      for (const raw of snapshot.runs.slice(-MAX_EXECUTIONS)) {
        const run = validRun(raw);
        if (run) runs.set(run.id, run);
      }
    }
  }
  loaded = true;
}

function snapshot(): ExecutionSnapshot {
  return {
    version: EXECUTION_VERSION,
    runs: [...runs.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_EXECUTIONS).map(run => ({ ...run }))
  };
}

async function persist(): Promise<void> {
  await writeDurableNow(EXECUTION_STATE, runs.size ? snapshot() : null);
}

function requireRun(id: string): ExecutionRun {
  const run = runs.get(id);
  if (!run) throw new Error(`Unknown autonomous execution: ${id}`);
  return run;
}

function automationFor(run: ExecutionRun): { mode: 'goal' | 'loop'; afterTurn: boolean } {
  return run.mode === 'infinite' ? { mode: 'loop', afterTurn: true } : { mode: 'goal', afterTurn: false };
}

async function pendingState(run: ExecutionRun): Promise<string | null> {
  if (!run.pendingInputId) return null;
  const row = (await listInputs()).find(input => input.id === run.pendingInputId);
  return row?.state ?? null;
}

async function observeRun(run: ExecutionRun, write = true): Promise<ExecutionView> {
  const session = run.sessionId ? await getSession(run.sessionId) : null;
  const conversationId = session?.conversationId ?? null;
  let changed = false;

  if (conversationId && run.lastConversationId && run.lastConversationId !== conversationId) {
    run.rollovers += 1;
    changed = true;
  }
  if (conversationId && run.lastConversationId !== conversationId) {
    run.lastConversationId = conversationId;
    changed = true;
  }
  if (run.status === 'starting' && conversationId) {
    run.status = 'running';
    run.updatedAt = Date.now();
    run.lastError = null;
    changed = true;
  }

  const inputState = await pendingState(run);
  if (run.status === 'starting' && !conversationId && (inputState === 'failed' || inputState === 'cancelled')) {
    run.status = 'failed';
    run.lastError = `The ${run.pendingInputKind ?? 'execution'} input is ${inputState} before a ChatGPT conversation was bound.`;
    run.updatedAt = Date.now();
    changed = true;
  }

  if (changed && write) await persist();
  const control = conversationId ? goalSwitchFor(conversationId) : null;
  return {
    ...run,
    conversationId,
    activeTurnId: session?.activeTurnId ?? null,
    automation: control ? { enabled: control.enabled, mode: control.mode, afterTurn: control.afterTurn } : null,
    objective: conversationId ? goalObjectiveFor(conversationId) || executionObjective(run) : executionObjective(run),
    pendingInputState: inputState
  };
}

async function prepareInput(run: ExecutionRun, kind: PendingInputKind): Promise<void> {
  if (!run.pendingInputId || run.pendingInputKind !== kind || run.pendingInputDueAt === null) {
    throw new Error('Execution input intent is incomplete');
  }
  if (kind === 'resume' && !run.sessionId) throw new Error('Execution resume has no durable session');
  const mode = automationFor(run);
  await enqueueInput({
    id: run.pendingInputId,
    sessionId: kind === 'opening' ? null : run.sessionId,
    text: kind === 'opening' ? executionBootstrapText(run) : executionResumeText(run),
    automation: mode.mode,
    loopAfterTurn: mode.afterTurn,
    objective: executionObjective(run),
    authoredSource: 'objective',
    mode: 'auto',
    dueAt: run.pendingInputDueAt,
    model: null,
    reasoningEffort: null
  });
}

async function disableAutomation(run: ExecutionRun): Promise<void> {
  if (!run.sessionId) return;
  const session = await getSession(run.sessionId);
  if (!session?.conversationId) return;
  const mode = automationFor(run);
  await setGoalSwitchNow(session.conversationId, mode.mode, false, mode.afterTurn);
}

async function enableAutomation(run: ExecutionRun): Promise<void> {
  if (!run.sessionId) return;
  const session = await getSession(run.sessionId);
  if (!session?.conversationId) return;
  const mode = automationFor(run);
  await setGoalObjectiveNow(session.conversationId, executionObjective(run));
  await setGoalSwitchNow(session.conversationId, mode.mode, true, mode.afterTurn);
}

async function cancelPending(run: ExecutionRun): Promise<void> {
  if (!run.pendingInputId) return;
  const row = (await listInputs()).find(input => input.id === run.pendingInputId);
  if (row && ['queued', 'browser', 'failed', 'cancelled'].includes(row.state)) {
    await cancelInput(run.pendingInputId);
  }
}

async function stopActiveTurn(run: ExecutionRun): Promise<void> {
  if (!run.sessionId) return;
  const session = await getSession(run.sessionId);
  if (!session?.conversationId || !session.activeTurnId) return;
  const { stopSessionTurn } = await import('./bridge.js');
  await stopSessionTurn(run.sessionId, session.activeTurnId);
}

function startIntent(run: ExecutionRun, kind: PendingInputKind, sessionId?: string): void {
  const id = randomUUID();
  run.pendingInputId = id;
  run.pendingInputKind = kind;
  run.pendingInputDueAt = Date.now();
  if (kind === 'opening') run.sessionId = sessionId ?? id;
  run.updatedAt = Date.now();
}

export function startExecution(input: { title?: string; plan: string; mode?: ExecutionMode }): Promise<ExecutionView> {
  return serial(async () => {
    await load();
    const plan = input.plan.trim();
    const title = (input.title ?? 'Autonomous execution').trim();
    if (!plan || plan.length > MAX_EXECUTION_PLAN_CHARS) throw new Error(`Execution plan must be 1-${MAX_EXECUTION_PLAN_CHARS} characters`);
    if (!title || title.length > MAX_EXECUTION_TITLE_CHARS) throw new Error(`Execution title must be 1-${MAX_EXECUTION_TITLE_CHARS} characters`);
    const now = Date.now();
    const run: ExecutionRun = {
      id: randomUUID(),
      title,
      plan,
      mode: input.mode ?? 'standard',
      status: 'starting',
      sessionId: null,
      pendingInputId: null,
      pendingInputKind: null,
      pendingInputDueAt: null,
      lastConversationId: null,
      rollovers: 0,
      createdAt: now,
      updatedAt: now,
      pausedAt: null,
      stoppedAt: null,
      completedAt: null,
      lastError: null
    };
    startIntent(run, 'opening');
    runs.set(run.id, run);
    await persist();
    try {
      await prepareInput(run, 'opening');
    } catch (error) {
      run.status = 'failed';
      run.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      run.updatedAt = Date.now();
      await persist();
    }
    return observeRun(run);
  });
}

export function executionStatus(id: string): Promise<ExecutionView> {
  return serial(async () => {
    await load();
    return observeRun(requireRun(id));
  });
}

export function listExecutions(): Promise<ExecutionView[]> {
  return serial(async () => {
    await load();
    const out: ExecutionView[] = [];
    for (const run of [...runs.values()].sort((a, b) => b.createdAt - a.createdAt)) out.push(await observeRun(run));
    return out;
  });
}

export function pauseExecution(id: string): Promise<ExecutionView> {
  return serial(async () => {
    await load();
    const run = requireRun(id);
    if (run.status === 'stopped' || run.status === 'completed') throw new Error(`Execution ${id} is already ${run.status}`);
    run.status = 'paused';
    run.pausedAt = Date.now();
    run.updatedAt = run.pausedAt;
    run.lastError = null;
    await persist();
    try {
      await cancelPending(run);
      await disableAutomation(run);
      await stopActiveTurn(run);
    } catch (error) {
      run.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      run.updatedAt = Date.now();
      await persist();
    }
    return observeRun(run);
  });
}

export function resumeExecution(id: string): Promise<ExecutionView> {
  return serial(async () => {
    await load();
    const run = requireRun(id);
    if (run.status === 'stopped' || run.status === 'completed') throw new Error(`Execution ${id} is terminal (${run.status})`);
    const session = run.sessionId ? await getSession(run.sessionId) : null;
    run.status = 'starting';
    run.pausedAt = null;
    run.lastError = null;
    if (session?.conversationId) {
      startIntent(run, 'resume');
    } else {
      startIntent(run, 'opening');
    }
    await persist();
    try {
      if (session?.conversationId) await enableAutomation(run);
      await prepareInput(run, run.pendingInputKind!);
    } catch (error) {
      run.status = 'failed';
      run.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      run.updatedAt = Date.now();
      await persist();
    }
    return observeRun(run);
  });
}

export function stopExecution(id: string): Promise<ExecutionView> {
  return serial(async () => {
    await load();
    const run = requireRun(id);
    if (run.status === 'completed' || run.status === 'stopped') return observeRun(run);
    run.status = 'stopped';
    run.stoppedAt = Date.now();
    run.updatedAt = run.stoppedAt;
    run.lastError = null;
    await persist();
    try {
      await cancelPending(run);
      await disableAutomation(run);
      await stopActiveTurn(run);
    } catch (error) {
      run.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      run.updatedAt = Date.now();
      await persist();
    }
    return observeRun(run);
  });
}

/**
 * Startup recovery is intentionally narrow:
 * - accepted start/resume intents whose input row never landed are replayed under the same UUID;
 * - paused/stopped executions have automation forced off;
 * - a bound starting execution becomes running.
 * Existing running conversations are otherwise left alone because the current COS Goal/Loop,
 * browser recovery and Compact & Resume owners already hold their continuation authority.
 */
export function reconcileExecutions(): Promise<void> {
  return serial(async () => {
    await load();
    const rows = await listInputs();
    for (const run of runs.values()) {
      if (run.status === 'paused' || run.status === 'stopped') {
        try { await disableAutomation(run); } catch { /* retain the durable pause/stop intent */ }
        continue;
      }
      if (run.status !== 'starting') {
        await observeRun(run);
        continue;
      }
      const session = run.sessionId ? await getSession(run.sessionId) : null;
      if (session?.conversationId) {
        try { await enableAutomation(run); } catch (error) {
          run.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        }
      }
      const pending = run.pendingInputId ? rows.find(row => row.id === run.pendingInputId) : null;
      if (!pending) {
        if (!run.pendingInputId || !run.pendingInputKind || run.pendingInputDueAt === null) {
          startIntent(run, session?.conversationId ? 'resume' : 'opening');
          await persist();
        }
        try { await prepareInput(run, run.pendingInputKind!); }
        catch (error) {
          run.status = 'failed';
          run.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
          run.updatedAt = Date.now();
          await persist();
          continue;
        }
      }
      await observeRun(run);
    }
  });
}

export function resetExecutionsForTests(): void {
  loaded = false;
  runs.clear();
  queue = Promise.resolve();
}
