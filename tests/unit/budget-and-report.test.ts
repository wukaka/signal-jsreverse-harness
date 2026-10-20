import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {recordApproval} from '../../src/core/approvals.js';
import {assertSubmissionBudget} from '../../src/core/budget.js';
import {submitLatestRun} from '../../src/core/live-submit.js';
import {saveOracle} from '../../src/core/oracle-store.js';
import type {OracleConfig} from '../../src/core/oracle.js';
import {renderTaskReport} from '../../src/core/report.js';
import {TaskStore, taskDir} from '../../src/core/task.js';

function init(workspace: string, budget = {submissions: 1, wall_time_min: 60}): TaskStore {
  return TaskStore.init(taskDir(workspace, 'test'), {
    task_id: 'test',
    goal: 'budget and report',
    profile: 'full',
    chain: 'offline',
    oracle_refs: ['fixture-oracle'],
    budget,
  });
}

function fixtureOracle(): OracleConfig {
  return {
    id: 'fixture-oracle',
    version: 1,
    kind: 'server_accept',
    scope: {endpoint: 'POST http://127.0.0.1:9/verify', param: 'sig', chain: 'offline'},
    verdict: {accept: ['json.status == 1']},
    calibration: {
      positive: [{ref: 'pos', expected: 'accept', approved_by: null}],
      negative_controls: [{ref: 'neg', expected: 'reject', approved_by: null}],
      require: {positive_accept_rate: 1, negative_reject_rate: 1},
    },
  };
}

test('submission budget is enforced', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-budget-'));
  try {
    const store = init(workspace, {submissions: 1, wall_time_min: 60});
    store.ledger.append('harness', 'oracle.result', {transport: 'live', verdict: 'reject'});
    assert.throws(() => assertSubmissionBudget(store), /submission budget exhausted/);

    const generatedPath = path.join(workspace, 'generated.json');
    fs.writeFileSync(generatedPath, JSON.stringify({url: 'http://127.0.0.1:9/verify'}), 'utf8');
    store.ledger.append('harness', 'run.recorded', {
      id: 'run-1',
      status: 'completed',
      artifacts: {generated: generatedPath},
    });
    await assert.rejects(
      submitLatestRun({
        store,
        bundle: {
          oracle: fixtureOracle(),
          calibration: {
            status: 'active',
            positiveApproved: true,
            positiveAcceptRate: 1,
            negativeRejectRate: 1,
            canL2: true,
            errors: [],
          },
        },
        authorizationRef: 'human-1',
        allowLive: true,
      }),
      /submission budget exhausted/,
    );
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('oracle save requires approval to canL2', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-oracle-'));
  try {
    const store = init(workspace);
    const unapproved = saveOracle(store, {oracle: fixtureOracle()});
    assert.equal(unapproved.calibration.status, 'unapproved_control');
    assert.equal(unapproved.calibration.canL2, false);

    const approved = saveOracle(store, {oracle: fixtureOracle(), approve: true});
    assert.equal(approved.calibration.status, 'active');
    assert.equal(approved.calibration.canL2, true);
    assert.ok(fs.existsSync(approved.path));
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('task report includes projections, negatives, and next action', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-report-'));
  try {
    const store = init(workspace);
    store.ledger.append('agent', 'hypothesis.proposed', {
      id: 'h-1',
      claim: 'claim one',
      falsifier: 'falsifier one',
      status: 'proposed',
    });
    store.ledger.append('agent', 'hypothesis.proposed', {
      id: 'h-2',
      claim: 'claim two',
      falsifier: 'falsifier two',
      status: 'refuted',
    });
    store.ledger.append('agent', 'experiment.planned', {
      id: 'e-1',
      kind: 'discriminating',
      targets: ['h-1', 'h-2'],
    });
    store.ledger.append('harness', 'experiment.completed', {id: 'e-1', gain: 0});
    store.ledger.append('harness', 'divergence.computed', {
      run_id: 'run-1',
      verdict: 'diverged',
      frontier: {symbol: 'env.fL', classification: 'value_mismatch'},
      meaningful_count: 1,
    });
    store.ledger.append('harness', 'oracle.result', {
      run_id: 'run-1',
      verdict: 'accept',
      evidence_level: 'L2',
      transport: 'live',
    });
    recordApproval(store, {
      kind: 'control',
      ref: 'human-approval-1',
      note: 'positive control reviewed',
    });

    const report = renderTaskReport(store);
    assert.match(report, /## 1\. Gate Status/);
    assert.match(report, /h-1/);
    assert.match(report, /## 6\. Negative Results/);
    assert.match(report, /h-2/);
    assert.match(report, /## 4\. Divergence History/);
    assert.match(report, /env\.fL/);
    assert.match(report, /evidence=`L2`/);
    assert.match(report, /## 8\. Next Highest-Information Action/);
    assert.match(report, /human-approval-1/);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});
