import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {attestGate, claimGate, currentStage, gateStatus} from '../../src/core/gates.js';
import {TaskStore, taskDir} from '../../src/core/task.js';

function initTask(profile: 'full' | 'light'): {workspace: string; store: TaskStore} {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-gates-'));
  const store = TaskStore.init(taskDir(workspace, 'test'), {
    task_id: 'test',
    goal: 'validate gate engine',
    profile,
    chain: 'offline',
    oracle_refs: ['mt-verify-accept'],
    budget: {submissions: 0, wall_time_min: 10},
  });
  return {workspace, store};
}

function addRun(store: TaskStore): void {
  store.ledger.append('harness', 'run.recorded', {
    id: 'run-1',
    status: 'completed',
    session_id: 'session-1',
  });
}

test('full profile enforces stage order and evidence requirements', () => {
  const {workspace, store} = initTask('full');
  try {
    assert.equal(currentStage(store), 'frame');
    assert.equal(claimGate(store, 'frame').accepted, true);

    const observeBeforeRun = claimGate(store, 'observe');
    assert.equal(observeBeforeRun.accepted, false);
    assert.deepEqual(observeBeforeRun.missing, ['completed_run']);

    addRun(store);
    assert.equal(claimGate(store, 'observe').accepted, true);

    const isolate = claimGate(store, 'isolate');
    assert.equal(isolate.accepted, false);
    assert.deepEqual(isolate.needs_human, ['failure_layer']);
    assert.deepEqual(isolate.missing, ['isolation_experiment']);

    attestGate(store, {
      stage: 'isolate',
      requirement: 'failure_layer',
      statement: 'content-layer rejection confirmed by ablation',
      failureLayer: 'content',
    });
    const isolateAfterAttest = claimGate(store, 'isolate');
    assert.equal(isolateAfterAttest.accepted, false);
    assert.deepEqual(isolateAfterAttest.needs_human, []);
    assert.deepEqual(isolateAfterAttest.missing, ['isolation_experiment']);

    store.ledger.append('agent', 'experiment.planned', {
      id: 'e-1',
      kind: 'discriminating',
      targets: ['h-1', 'h-2'],
      variable: 'x',
    });
    store.ledger.append('harness', 'experiment.completed', {
      id: 'e-1',
      kind: 'discriminating',
      targets: ['h-1', 'h-2'],
      gain: 1,
    });
    assert.equal(claimGate(store, 'isolate').accepted, true);

    store.ledger.append('agent', 'hypothesis.proposed', {
      id: 'h-1',
      claim: 'c1',
      falsifier: 'f1',
      status: 'proposed',
    });
    store.ledger.append('agent', 'hypothesis.proposed', {
      id: 'h-2',
      claim: 'c2',
      falsifier: 'f2',
      status: 'proposed',
    });
    assert.equal(claimGate(store, 'hypothesize').accepted, true);

    store.ledger.append('harness', 'divergence.computed', {
      run_id: 'run-1',
      verdict: 'diverged',
      frontier: {symbol: 'env.brVD', index: 3},
    });
    assert.equal(claimGate(store, 'rebuild').accepted, true);

    const validateBefore = claimGate(store, 'validate');
    assert.equal(validateBefore.accepted, false);
    assert.deepEqual(validateBefore.missing, ['l2_accept']);

    store.ledger.append('harness', 'oracle.result', {
      evidence_level: 'L2',
      verdict: 'accept',
    });
    assert.equal(claimGate(store, 'validate').accepted, true);
    assert.equal(currentStage(store), null);
    assert.throws(() => claimGate(store, 'validate'), /all gates already accepted/);

    const status = gateStatus(store);
    assert.equal(status.current_stage, null);
    assert.equal(
      status.stages.every(stage => stage.status === 'accepted'),
      true,
    );
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('light profile skips hypothesis requirements but keeps L2', () => {
  const {workspace, store} = initTask('light');
  try {
    assert.equal(claimGate(store, 'frame').accepted, true);
    addRun(store);
    assert.equal(claimGate(store, 'observe').accepted, true);

    const isolate = claimGate(store, 'isolate');
    assert.equal(isolate.accepted, false);
    assert.deepEqual(isolate.needs_human, ['failure_layer']);
    attestGate(store, {
      stage: 'isolate',
      requirement: 'failure_layer',
      statement: 'time-layer rejection',
      failureLayer: 'time',
    });
    assert.equal(claimGate(store, 'isolate').accepted, true);
    assert.equal(claimGate(store, 'hypothesize').accepted, true);
    assert.equal(claimGate(store, 'rebuild').accepted, true);

    const validate = claimGate(store, 'validate');
    assert.equal(validate.accepted, false);
    assert.deepEqual(validate.missing, ['l2_accept']);

    store.ledger.append('harness', 'oracle.result', {
      evidence_level: 'L2',
      verdict: 'accept',
    });
    assert.equal(claimGate(store, 'validate').accepted, true);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('gate order violation is rejected', () => {
  const {workspace, store} = initTask('full');
  try {
    assert.throws(() => claimGate(store, 'observe'), /gate order violation/);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});
