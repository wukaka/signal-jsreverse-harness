import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {parseHeaderOverrides, submitLatestRun} from '../../src/core/live-submit.js';
import {evaluateCalibration, type OracleConfig} from '../../src/core/oracle.js';
import {TaskStore, taskDir} from '../../src/core/task.js';

function oracleFor(port: number, id: string): OracleConfig {
  return {
    id,
    version: 1,
    kind: 'server_accept',
    scope: {endpoint: `POST http://127.0.0.1:${port}/verify`, param: 'sig', chain: 'offline'},
    submission: {transport: 'http', side_effect: 'read_only', timeout_ms: 2000},
    verdict: {
      accept: ['http_status == 200', 'json.status == 1'],
      reject: ['json.error.code == 121079'],
    },
    calibration: {
      positive: [
        {
          ref: 'fixture-positive',
          expected: 'accept',
          approved_by: 'human',
          validation_mode: 'original_acceptance',
        },
      ],
      negative_controls: [{ref: 'fixture-negative', expected: 'reject', approved_by: 'human'}],
      require: {positive_accept_rate: 1, negative_reject_rate: 1},
    },
  };
}

async function withServer(run: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({status: 1, data: {ok: true}}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    await run(address.port);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('live submit records L2 for a calibrated oracle accept', async () => {
  await withServer(async port => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-live-'));
    try {
      const store = TaskStore.init(taskDir(workspace, 'test'), {
        task_id: 'test',
        goal: 'live submit',
        profile: 'full',
        chain: 'offline',
        oracle_refs: ['test-oracle'],
        budget: {submissions: 1, wall_time_min: 10},
      });
      const generatedPath = path.join(workspace, 'generated.json');
      fs.writeFileSync(
        generatedPath,
        JSON.stringify({
          url: `http://127.0.0.1:${port}/verify`,
          method: 'POST',
          headers: {'content-type': 'application/x-www-form-urlencoded'},
          body: 'sig=abc',
        }),
        'utf8',
      );
      store.ledger.append('harness', 'run.recorded', {
        id: 'run-live',
        status: 'completed',
        session_id: 'session-live',
        artifacts: {generated: generatedPath},
      });
      const oracle = oracleFor(port, `live-${port}`);
      const calibration = evaluateCalibration(oracle, {
        positive: ['accept'],
        negative: ['reject'],
      });
      assert.equal(calibration.canL2, true);

      const result = await submitLatestRun({
        store,
        bundle: {oracle, calibration},
        authorizationRef: 'human-approval-1',
        allowLive: true,
        sessionId: 'session-live',
        headers: {'user-agent': 'fixture-agent'},
      });
      assert.equal(result.submission.verdict, 'accept');
      assert.equal(result.submission.evidence_level, 'L2');
      assert.equal(result.submission.authorization_ref, 'human-approval-1');
      assert.equal(result.http.http_status, 200);
    } finally {
      fs.rmSync(workspace, {recursive: true, force: true});
    }
  });
});

test('live submit refuses when allowLive is false', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-live-off-'));
  try {
    const store = TaskStore.init(taskDir(workspace, 'test'), {
      task_id: 'test',
      goal: 'live submit disabled',
      profile: 'full',
      chain: 'offline',
      oracle_refs: ['test-oracle'],
      budget: {submissions: 0, wall_time_min: 10},
    });
    const generatedPath = path.join(workspace, 'generated.json');
    fs.writeFileSync(generatedPath, JSON.stringify({url: 'http://127.0.0.1:1/verify'}), 'utf8');
    store.ledger.append('harness', 'run.recorded', {
      id: 'run-1',
      status: 'completed',
      artifacts: {generated: generatedPath},
    });
    const oracle = oracleFor(1, 'disabled');
    const calibration = evaluateCalibration(oracle, {positive: ['accept'], negative: ['reject']});
    await assert.rejects(
      submitLatestRun({
        store,
        bundle: {oracle, calibration},
        authorizationRef: 'human-1',
        allowLive: false,
      }),
      /disabled/,
    );
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('header overrides parse colon-delimited values', () => {
  assert.deepEqual(parseHeaderOverrides(['x-test: value:with:colons']), {
    'x-test': 'value:with:colons',
  });
});
