import fs from 'node:fs';
import path from 'node:path';

import {assertSubmissionBudget} from './budget.js';
import {submitHttp, type HttpRequestSpec, type HttpSubmitResult} from './http-submitter.js';
import type {OracleBundle} from './oracle-loader.js';
import {SubmitService, type SubmissionRecord} from './submit.js';
import type {TaskStore} from './task.js';

export interface LiveSubmitOptions {
  store: TaskStore;
  bundle: OracleBundle;
  authorizationRef: string;
  allowLive: boolean;
  runId?: string;
  sessionId?: string;
  headers?: Record<string, string>;
  artifactRoot?: string;
}

export interface LiveSubmitResult {
  run: Record<string, unknown>;
  http: HttpSubmitResult;
  submission: SubmissionRecord;
}

export async function submitLatestRun(options: LiveSubmitOptions): Promise<LiveSubmitResult> {
  assertSubmissionBudget(options.store);
  const projection = options.store.projection();
  const matching = projection.runs.filter(run => {
    if (options.runId) return run['id'] === options.runId;
    if (options.sessionId) return run['session_id'] === options.sessionId;
    return true;
  });
  const run = matching.at(-1);
  if (!run) throw new Error('no matching run found');

  const artifacts = run['artifacts'] as Record<string, unknown> | undefined;
  const generatedPath = artifacts?.['generated'];
  if (typeof generatedPath !== 'string' || !fs.existsSync(generatedPath)) {
    throw new Error(`run ${String(run['id'])} has no generated request artifact`);
  }
  const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8')) as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  const request: HttpRequestSpec = {
    url: generated.url,
    method: generated.method ?? 'POST',
    headers: {...(generated.headers ?? {}), ...(options.headers ?? {})},
    body: generated.body,
  };
  const artifactDir = path.join(
    options.artifactRoot ?? path.dirname(generatedPath),
    `submission-${Date.now()}`,
  );
  const http = await submitHttp({
    oracle: options.bundle.oracle,
    request,
    allowLive: options.allowLive,
    authorizationRef: options.authorizationRef,
    artifactDir,
  });
  const submission = new SubmitService(options.store.ledger, options.store.taskId).submitLive({
    oracle: options.bundle.oracle,
    calibration: options.bundle.calibration,
    http,
    runId: String(run['id']),
    authorizationRef: options.authorizationRef,
  });
  return {run, http, submission};
}

export function parseHeaderOverrides(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of values) {
    const index = entry.indexOf(':');
    if (index <= 0) throw new Error(`invalid header override: ${entry}`);
    headers[entry.slice(0, index).trim()] = entry.slice(index + 1).trim();
  }
  return headers;
}
