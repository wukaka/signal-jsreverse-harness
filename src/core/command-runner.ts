import fs from 'node:fs';
import path from 'node:path';

import {
  compareTraces,
  type DivergenceResult,
  type SemanticEvent,
  type Trace,
} from './divergence.js';
import {runCommand, type ExecResult} from './executor.js';
import {canonicalJson, sha256} from './ledger.js';
import {sha256String, type ComparabilityKeys, type RunRecord} from './runs.js';
import type {TaskStore} from './task.js';

export interface CommandRunSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  output_path?: string;
  trace_path?: string;
  reference_trace_path?: string;
  volatile_symbols?: string[];
  comparability?: Partial<ComparabilityKeys>;
}

export interface CommandRunResult {
  run: RunRecord;
  exec: ExecResult;
  output: string;
  trace: Trace | null;
  divergence: DivergenceResult | null;
  artifactsDir: string;
}

export async function runManagedCommand(
  store: TaskStore,
  spec: CommandRunSpec,
  options: {iteration?: number; repeatIndex?: number} = {},
): Promise<CommandRunResult> {
  if (!spec.command) throw new Error('command run spec requires a command');
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const artifactsDir = path.join(store.rootDir, 'runs', runId);
  fs.mkdirSync(artifactsDir, {recursive: true, mode: 0o700});

  const exec = await runCommand({
    command: spec.command,
    args: spec.args ?? [],
    cwd: spec.cwd ?? process.cwd(),
    env: {...process.env, ...(spec.env ?? {})},
    timeoutMs: spec.timeout_ms ?? 60_000,
  });

  const stdoutPath = path.join(artifactsDir, 'stdout.log');
  const stderrPath = path.join(artifactsDir, 'stderr.log');
  fs.writeFileSync(stdoutPath, exec.stdout, 'utf8');
  fs.writeFileSync(stderrPath, exec.stderr, 'utf8');
  const artifacts: Record<string, string> = {stdout: stdoutPath, stderr: stderrPath};

  let output = exec.stdout;
  if (spec.output_path && fs.existsSync(spec.output_path)) {
    output = fs.readFileSync(spec.output_path, 'utf8');
    const outputCopy = path.join(artifactsDir, 'output.txt');
    fs.writeFileSync(outputCopy, output, 'utf8');
    artifacts.output = outputCopy;
  }

  let trace: Trace | null = null;
  if (spec.trace_path && fs.existsSync(spec.trace_path)) {
    trace = readTrace(spec.trace_path, runId);
    const traceCopy = path.join(artifactsDir, 'trace.jsonl');
    fs.writeFileSync(
      traceCopy,
      trace.events.map(event => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    );
    artifacts.trace = traceCopy;
  }

  const comparability: ComparabilityKeys = {
    event_schema: 'v1',
    instrumentation_hash: sha256String(
      `${spec.command}:${JSON.stringify(spec.args ?? [])}:${JSON.stringify(spec.env ?? {})}`,
    ),
    material_pair_hash: sha256String(`material:${JSON.stringify(spec.env ?? {})}`),
    focus_hash: sha256String('focus:all'),
    comparison_policy_hash: sha256String(`policy:v1:${(spec.volatile_symbols ?? []).join(',')}`),
    ...spec.comparability,
  };

  const run: RunRecord = {
    id: runId,
    task_id: store.taskId,
    iteration: options.iteration ?? 1,
    repeat_index: options.repeatIndex ?? 1,
    type: 'execute',
    side: 'candidate',
    status:
      exec.status === 'completed' ? 'completed' : exec.status === 'timeout' ? 'timeout' : 'failed',
    comparability,
    artifacts,
    result: {output_digest: sha256(output), oracle_verdict: null},
    created_at: new Date().toISOString(),
  };
  store.ledger.append('harness', 'run.recorded', {...run}, Object.values(artifacts));
  fs.writeFileSync(path.join(artifactsDir, 'run.json'), JSON.stringify(run, null, 2), 'utf8');

  let divergence: DivergenceResult | null = null;
  if (trace && spec.reference_trace_path && fs.existsSync(spec.reference_trace_path)) {
    const reference = readTrace(spec.reference_trace_path, 'reference');
    divergence = compareTraces([reference, reference], [trace], {
      volatile_symbols: spec.volatile_symbols ?? [],
    });
    store.ledger.append(
      'harness',
      'divergence.computed',
      {
        run_id: run.id,
        verdict: divergence.verdict,
        frontier: divergence.frontier,
        meaningful_count: divergence.meaningful.length,
        noise_signatures: divergence.noise_signatures,
        coverage_gaps: divergence.coverage_gaps,
      },
      [run.id],
    );
  }

  return {run, exec, output, trace, divergence, artifactsDir};
}

export function readTrace(file: string, runId: string): Trace {
  const events = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as SemanticEvent);
  return {run_id: runId, events};
}

export function commandRunSpecFromConfig(config: Record<string, unknown>): CommandRunSpec {
  const spec = config as unknown as CommandRunSpec;
  if (!spec.command) throw new Error('experiment config is missing command');
  return spec;
}

export function outputDigest(output: string): string {
  return sha256(canonicalJson(output));
}
