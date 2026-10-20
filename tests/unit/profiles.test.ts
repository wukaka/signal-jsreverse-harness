import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {claimGate, currentStage} from '../../src/core/gates.js';
import {
  loadProfile,
  profileRootsForTask,
  validateProfile,
  type ProfileDefinition,
} from '../../src/core/profiles.js';
import {TaskStore, taskDir} from '../../src/core/task.js';

const STRICT_PROFILE: ProfileDefinition = {
  name: 'strict',
  description: 'custom test profile',
  stages: [
    {
      id: 'frame',
      name: 'Frame',
      requirements: [
        {
          id: 'goal',
          kind: 'evidence',
          description: 'goal set',
          rule: {metric: 'goal_set', op: '==', value: true},
        },
      ],
    },
    {
      id: 'observe',
      name: 'Observe',
      requirements: [
        {
          id: 'two_runs',
          kind: 'evidence',
          description: 'two completed runs',
          rule: {metric: 'completed_runs', op: '>=', value: 2},
        },
      ],
    },
    {id: 'done', name: 'Done', requirements: []},
  ],
};

test('custom profile drives stage order and evidence rules', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-profile-'));
  try {
    const root = taskDir(workspace, 'test');
    const profileDir = path.join(root, 'profiles');
    fs.mkdirSync(profileDir, {recursive: true});
    fs.writeFileSync(
      path.join(profileDir, 'strict.json'),
      JSON.stringify(STRICT_PROFILE, null, 2),
      'utf8',
    );
    const store = TaskStore.init(root, {
      task_id: 'test',
      goal: 'custom profile',
      profile: 'strict',
      chain: 'offline',
      oracle_refs: [],
      budget: {submissions: 0, wall_time_min: 10},
    });

    assert.equal(currentStage(store), 'frame');
    assert.equal(claimGate(store, 'frame').accepted, true);

    const observe = claimGate(store, 'observe');
    assert.equal(observe.accepted, false);
    assert.deepEqual(observe.missing, ['two_runs']);

    for (const id of ['run-1', 'run-2']) {
      store.ledger.append('harness', 'run.recorded', {id, status: 'completed'});
    }
    assert.equal(claimGate(store, 'observe').accepted, true);
    assert.equal(claimGate(store, 'done').accepted, true);
    assert.equal(currentStage(store), null);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('workspace-level profiles are discoverable', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-profile-ws-'));
  try {
    const taskRoot = taskDir(workspace, 'test');
    fs.mkdirSync(path.join(workspace, '.harness', 'profiles'), {recursive: true});
    fs.writeFileSync(
      path.join(workspace, '.harness', 'profiles', 'workspace-strict.json'),
      JSON.stringify({...STRICT_PROFILE, name: 'workspace-strict'}),
      'utf8',
    );
    const profile = loadProfile('workspace-strict', profileRootsForTask(taskRoot));
    assert.equal(profile.name, 'workspace-strict');
    assert.equal(profile.stages.length, 3);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('profile validation rejects unknown metrics and duplicate stages', () => {
  assert.throws(
    () =>
      validateProfile({
        name: 'bad',
        stages: [
          {
            id: 'a',
            name: 'A',
            requirements: [
              {
                id: 'r',
                kind: 'evidence',
                description: 'bad metric',
                rule: {metric: 'nope', op: '==', value: 1},
              },
            ],
          },
        ],
      }),
    /unknown metric/,
  );

  assert.throws(
    () =>
      validateProfile({
        name: 'bad',
        stages: [
          {id: 'a', name: 'A', requirements: []},
          {id: 'a', name: 'A2', requirements: []},
        ],
      }),
    /duplicate stage/,
  );

  assert.throws(
    () =>
      validateProfile({
        name: 'bad',
        stages: [
          {
            id: 'a',
            name: 'A',
            requirements: [{id: 'r', kind: 'human', description: 'no key'}],
          },
        ],
      }),
    /needs an attestation key/,
  );
});
