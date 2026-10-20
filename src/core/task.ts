import fs from 'node:fs';
import path from 'node:path';

import {Ledger, type LedgerEvent} from './ledger.js';
import {replay, type Experiment, type ExperimentState, type Hypothesis} from './experiments.js';

export type TaskProfile = string;
export type TaskChain = 'browser' | 'offline' | 'hybrid';

export interface TaskConfig {
  task_id: string;
  goal: string;
  profile: TaskProfile;
  chain: TaskChain;
  oracle_refs: string[];
  budget: {
    submissions: number;
    wall_time_min: number;
  };
  created_at: string;
}

export interface TaskProjection {
  task: TaskConfig;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  runs: Array<Record<string, unknown>>;
  oracle_results: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  stop: {
    triggered: boolean;
    reason: string | null;
    streak: number;
    deferrals_consumed: number;
  };
  human_interventions: number;
  frontier: Record<string, unknown> | null;
}

export class TaskStore {
  private constructor(
    readonly rootDir: string,
    readonly config: TaskConfig,
    readonly ledger: Ledger,
  ) {}

  static init(rootDir: string, config: Omit<TaskConfig, 'created_at'>): TaskStore {
    fs.mkdirSync(rootDir, {recursive: true, mode: 0o700});
    const taskFile = path.join(rootDir, 'task.json');
    if (fs.existsSync(taskFile)) {
      throw new Error(`task already initialized: ${taskFile}`);
    }
    const fullConfig: TaskConfig = {...config, created_at: new Date().toISOString()};
    fs.writeFileSync(taskFile, JSON.stringify(fullConfig, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.mkdirSync(path.join(rootDir, 'runs'), {recursive: true, mode: 0o700});
    fs.mkdirSync(path.join(rootDir, 'artifacts'), {recursive: true, mode: 0o700});
    const harnessRoot = path.resolve(rootDir, '..', '..');
    fs.writeFileSync(path.join(harnessRoot, '.gitignore'), '*\n', 'utf8');
    const store = new TaskStore(
      rootDir,
      fullConfig,
      Ledger.open(path.join(rootDir, 'ledger.jsonl'), config.task_id),
    );
    store.ledger.append('harness', 'task.initialized', {
      task_id: config.task_id,
      goal: config.goal,
      profile: config.profile,
      chain: config.chain,
      oracle_refs: config.oracle_refs,
      budget: config.budget,
    });
    return store;
  }

  static open(rootDir: string): TaskStore {
    const taskFile = path.join(rootDir, 'task.json');
    if (!fs.existsSync(taskFile)) {
      throw new Error(`task not initialized: ${taskFile}`);
    }
    const config = JSON.parse(fs.readFileSync(taskFile, 'utf8')) as TaskConfig;
    return new TaskStore(
      rootDir,
      config,
      Ledger.open(path.join(rootDir, 'ledger.jsonl'), config.task_id),
    );
  }

  get taskId(): string {
    return this.config.task_id;
  }

  projection(): TaskProjection {
    return projectTask(this.config, this.ledger.read());
  }
}

export function taskDir(workspaceRoot: string, taskId: string): string {
  return path.join(workspaceRoot, '.harness', 'tasks', taskId);
}

export function projectTask(config: TaskConfig, events: LedgerEvent[]): TaskProjection {
  const experimentState: ExperimentState = replay(events).state;
  const runs: Array<Record<string, unknown>> = [];
  const oracleResults: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  let frontier: Record<string, unknown> | null = null;
  let humanInterventions = 0;

  for (const event of events) {
    switch (event.type) {
      case 'run.recorded':
        runs.push(event.payload);
        break;
      case 'oracle.result':
        oracleResults.push(event.payload);
        break;
      case 'evidence.recorded':
        evidence.push(event.payload);
        break;
      case 'divergence.computed':
        frontier = (event.payload.frontier as Record<string, unknown> | null) ?? null;
        break;
      case 'human.decision':
        humanInterventions++;
        break;
      default:
        break;
    }
  }

  return {
    task: config,
    hypotheses: Object.values(experimentState.hypotheses),
    experiments: Object.values(experimentState.experiments),
    runs,
    oracle_results: oracleResults,
    evidence,
    stop: {
      triggered: experimentState.stopTriggered,
      reason: experimentState.stopReason,
      streak: experimentState.streak,
      deferrals_consumed: experimentState.deferralsConsumed,
    },
    human_interventions: humanInterventions,
    frontier,
  };
}
