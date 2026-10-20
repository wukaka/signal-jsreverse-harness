import fs from 'node:fs';
import path from 'node:path';

import {
  evaluateCalibration,
  type CalibrationResult,
  type OracleConfig,
  type VerdictClass,
} from './oracle.js';

export interface OracleBundle {
  oracle: OracleConfig;
  calibration: CalibrationResult;
}

export function loadOracleBundle(
  taskRoot: string,
  oracleId: string,
  fallback?: OracleConfig,
): OracleBundle {
  const oraclePath = path.join(taskRoot, 'oracles', `${oracleId}.json`);
  if (fs.existsSync(oraclePath)) {
    const bundle = JSON.parse(fs.readFileSync(oraclePath, 'utf8')) as {
      oracle: OracleConfig;
      observed?: {positive?: VerdictClass[]; negative?: VerdictClass[]};
    };
    return {
      oracle: bundle.oracle,
      calibration: evaluateCalibration(bundle.oracle, {
        positive: bundle.observed?.positive ?? ['accept'],
        negative: bundle.observed?.negative ?? ['reject'],
      }),
    };
  }
  if (!fallback) throw new Error(`unknown oracle: ${oracleId}`);
  return {
    oracle: fallback,
    calibration: evaluateCalibration(fallback, {positive: ['accept'], negative: ['reject']}),
  };
}
