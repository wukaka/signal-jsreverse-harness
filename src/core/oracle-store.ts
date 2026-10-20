import fs from 'node:fs';
import path from 'node:path';

import {
  evaluateCalibration,
  type CalibrationResult,
  type OracleConfig,
  type VerdictClass,
} from './oracle.js';
import type {TaskStore} from './task.js';

export interface OracleFile {
  oracle: OracleConfig;
  observed: {
    positive: VerdictClass[];
    negative: VerdictClass[];
  };
}

export function saveOracle(
  store: TaskStore,
  input: {
    oracle: OracleConfig;
    observed?: {positive?: VerdictClass[]; negative?: VerdictClass[]};
    approve?: boolean;
  },
): {path: string; calibration: CalibrationResult} {
  const oracle = {...input.oracle};
  if (input.approve) {
    oracle.calibration = {
      ...oracle.calibration,
      positive: oracle.calibration.positive.map(sample => ({...sample, approved_by: 'human'})),
      negative_controls: oracle.calibration.negative_controls.map(sample => ({
        ...sample,
        approved_by: 'human',
      })),
    };
  }
  const observed = {
    positive: input.observed?.positive ?? ['accept' as VerdictClass],
    negative: input.observed?.negative ?? ['reject' as VerdictClass],
  };
  const dir = path.join(store.rootDir, 'oracles');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = path.join(dir, `${oracle.id}.json`);
  fs.writeFileSync(file, JSON.stringify({oracle, observed}, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (!store.config.oracle_refs.includes(oracle.id)) {
    store.config.oracle_refs.push(oracle.id);
    fs.writeFileSync(
      path.join(store.rootDir, 'task.json'),
      JSON.stringify(store.config, null, 2),
      'utf8',
    );
  }
  if (input.approve) {
    store.ledger.append('human', 'human.decision', {
      kind: 'control_approval',
      oracle_id: oracle.id,
      authorization_ref: `oracle:${oracle.id}`,
      note: 'positive and negative controls approved by human',
    });
  }
  return {
    path: file,
    calibration: evaluateCalibration(oracle, observed),
  };
}

export function loadOracleFile(store: TaskStore, oracleId: string): OracleFile | null {
  const file = path.join(store.rootDir, 'oracles', `${oracleId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OracleFile;
}
