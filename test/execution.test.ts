import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  executionStatus,
  listExecutions,
  pauseExecution,
  reconcileExecutions,
  resetExecutionsForTests,
  resumeExecution,
  startExecution,
  stopExecution
} from '../src/main/execution.js';
import { resetGoalStateForTests } from '../src/main/goal.js';
import { configureInputDelivery, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { getSession, initSessionStore, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;

beforeEach(async () => {
  directory = await makeTempDir('cos-execution-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  resetInputForTests();
  resetExecutionsForTests();
  resetGoalStateForTests();
  await saveConfig(defaultConfig());
  configureInputDelivery({ applyAutomation: async () => {}, changed: () => {} });
});

afterEach(async () => {
  await flushDurable();
  resetExecutionsForTests();
  resetInputForTests();
  resetGoalStateForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

describe('current-native autonomous execution', () => {
  it('starts through the durable opening input and maps infinite mode to Loop', async () => {
    const run = await startExecution({ title: 'Autonomous repair', plan: 'Repair and verify the repository.', mode: 'infinite' });
    expect(run).toMatchObject({ status: 'starting', mode: 'infinite', rollovers: 0, conversationId: null });
    expect(run.sessionId).toBe(run.pendingInputId);
    const input = (await listInputs()).find(row => row.id === run.pendingInputId)!;
    expect(input).toMatchObject({
      sessionId: run.sessionId,
      opening: true,
      state: 'queued',
      automation: 'loop',
      loopAfterTurn: true,
      objective: expect.stringContaining('Repair and verify the repository.')
    });
    expect(await getSession(run.sessionId!)).toMatchObject({ id: run.sessionId, conversationId: null, origin: { kind: 'desktop' } });
  });

  it('pauses an unbound start without replaying it and resumes under a fresh exact opening identity', async () => {
    const started = await startExecution({ plan: 'Complete the task.' });
    const paused = await pauseExecution(started.id);
    expect(paused.status).toBe('paused');
    expect((await listInputs()).find(row => row.id === started.pendingInputId)?.state).toBe('cancelled');

    const resumed = await resumeExecution(started.id);
    expect(resumed.status).toBe('starting');
    expect(resumed.pendingInputId).not.toBe(started.pendingInputId);
    expect(resumed.sessionId).toBe(resumed.pendingInputId);
    expect((await listInputs()).find(row => row.id === resumed.pendingInputId)).toMatchObject({ state: 'queued', opening: true });
  });

  it('tracks current COS Compact & Resume rebinding as a rollover without inventing a second execution session', async () => {
    const started = await startExecution({ plan: 'Implement and verify.' });
    const firstConversation = randomUUID();
    expect(await rebindSession(started.sessionId!, null, firstConversation)).toBe(true);
    const running = await executionStatus(started.id);
    expect(running).toMatchObject({ status: 'running', conversationId: firstConversation, rollovers: 0 });

    const replacement = randomUUID();
    expect(await rebindSession(started.sessionId!, firstConversation, replacement)).toBe(true);
    const rolled = await executionStatus(started.id);
    expect(rolled).toMatchObject({ status: 'running', conversationId: replacement, rollovers: 1, sessionId: started.sessionId });
  });

  it('recovers a persisted starting intent without creating a second run', async () => {
    const started = await startExecution({ plan: 'Keep the accepted execution durable.' });
    resetExecutionsForTests();
    await reconcileExecutions();
    const restored = await listExecutions();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: started.id, sessionId: started.sessionId, pendingInputId: started.pendingInputId });
    expect((await listInputs()).filter(row => row.id === started.pendingInputId)).toHaveLength(1);
  });

  it('stops an unbound execution durably and leaves its opening cancelled', async () => {
    const started = await startExecution({ plan: 'Do not survive a stop.' });
    const stopped = await stopExecution(started.id);
    expect(stopped.status).toBe('stopped');
    expect((await listInputs()).find(row => row.id === started.pendingInputId)?.state).toBe('cancelled');
    await expect(resumeExecution(started.id)).rejects.toThrow('terminal');
  });
});
