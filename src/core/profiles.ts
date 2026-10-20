import fs from 'node:fs';
import path from 'node:path';

import type {LedgerEvent} from './ledger.js';
import type {TaskConfig, TaskProjection} from './task.js';

export type RuleOp = '==' | '!=' | '>=' | '<=' | '>' | '<' | 'in' | 'exists';

export interface ProfileRule {
  metric: string;
  op: RuleOp;
  value?: unknown;
}

export interface ProfileRequirement {
  id: string;
  kind: 'evidence' | 'human';
  description: string;
  rule?: ProfileRule;
  attestation?: string;
}

export interface ProfileStage {
  id: string;
  name: string;
  requirements: ProfileRequirement[];
}

export interface ProfileDefinition {
  name: string;
  description?: string;
  stages: ProfileStage[];
}

const RULE_OPS: RuleOp[] = ['==', '!=', '>=', '<=', '>', '<', 'in', 'exists'];

export const METRICS = new Set([
  'goal_set',
  'oracle_refs',
  'completed_runs',
  'session_runs',
  'total_hypotheses',
  'open_hypotheses',
  'planned_experiments',
  'discriminating_plans',
  'completed_discriminating',
  'has_frontier',
  'l2_accepts',
  'stop_triggered',
  'refuted_hypotheses',
  'human_attestations',
]);

const FULL_PROFILE: ProfileDefinition = {
  name: 'full',
  description: 'High-uncertainty tasks with hypothesis and experiment discipline',
  stages: [
    {
      id: 'frame',
      name: 'Frame',
      requirements: [
        {
          id: 'goal',
          kind: 'evidence',
          description: 'task goal is set',
          rule: {metric: 'goal_set', op: '==', value: true},
        },
        {
          id: 'oracle_scope',
          kind: 'evidence',
          description: 'at least one oracle is referenced',
          rule: {metric: 'oracle_refs', op: '>=', value: 1},
        },
      ],
    },
    {
      id: 'observe',
      name: 'Observe & Baseline',
      requirements: [
        {
          id: 'completed_run',
          kind: 'evidence',
          description: 'at least one completed managed run',
          rule: {metric: 'completed_runs', op: '>=', value: 1},
        },
      ],
    },
    {
      id: 'isolate',
      name: 'Isolate',
      requirements: [
        {
          id: 'failure_layer',
          kind: 'human',
          description: 'human attests the failing layer',
          attestation: 'failure_layer',
        },
        {
          id: 'isolation_experiment',
          kind: 'evidence',
          description: 'at least one completed discriminating experiment',
          rule: {metric: 'completed_discriminating', op: '>=', value: 1},
        },
      ],
    },
    {
      id: 'hypothesize',
      name: 'Hypothesize & Experiment',
      requirements: [
        {
          id: 'two_hypotheses',
          kind: 'evidence',
          description: 'at least two hypotheses recorded',
          rule: {metric: 'total_hypotheses', op: '>=', value: 2},
        },
        {
          id: 'discriminating_plan',
          kind: 'evidence',
          description: 'a discriminating experiment targets at least two hypotheses',
          rule: {metric: 'discriminating_plans', op: '>=', value: 1},
        },
      ],
    },
    {
      id: 'rebuild',
      name: 'Rebuild & Validate',
      requirements: [
        {
          id: 'session_run',
          kind: 'evidence',
          description: 'a completed run is bound to a session',
          rule: {metric: 'session_runs', op: '>=', value: 1},
        },
        {
          id: 'frontier',
          kind: 'evidence',
          description: 'a divergence frontier is recorded',
          rule: {metric: 'has_frontier', op: '==', value: true},
        },
      ],
    },
    {
      id: 'validate',
      name: 'Validate',
      requirements: [
        {
          id: 'l2_accept',
          kind: 'evidence',
          description: 'an L2 oracle accept is recorded',
          rule: {metric: 'l2_accepts', op: '>=', value: 1},
        },
      ],
    },
  ],
};

const LIGHT_PROFILE: ProfileDefinition = {
  name: 'light',
  description: 'Short, single-parameter tasks with minimal ledger ceremony',
  stages: [
    {
      id: 'frame',
      name: 'Frame',
      requirements: [
        {
          id: 'goal',
          kind: 'evidence',
          description: 'task goal is set',
          rule: {metric: 'goal_set', op: '==', value: true},
        },
        {
          id: 'oracle_scope',
          kind: 'evidence',
          description: 'at least one oracle is referenced',
          rule: {metric: 'oracle_refs', op: '>=', value: 1},
        },
      ],
    },
    {
      id: 'observe',
      name: 'Observe & Baseline',
      requirements: [
        {
          id: 'completed_run',
          kind: 'evidence',
          description: 'at least one completed managed run',
          rule: {metric: 'completed_runs', op: '>=', value: 1},
        },
      ],
    },
    {
      id: 'isolate',
      name: 'Isolate',
      requirements: [
        {
          id: 'failure_layer',
          kind: 'human',
          description: 'human attests the failing layer',
          attestation: 'failure_layer',
        },
      ],
    },
    {
      id: 'hypothesize',
      name: 'Hypothesize & Experiment',
      requirements: [],
    },
    {
      id: 'rebuild',
      name: 'Rebuild & Validate',
      requirements: [
        {
          id: 'session_run',
          kind: 'evidence',
          description: 'a completed run is bound to a session',
          rule: {metric: 'session_runs', op: '>=', value: 1},
        },
      ],
    },
    {
      id: 'validate',
      name: 'Validate',
      requirements: [
        {
          id: 'l2_accept',
          kind: 'evidence',
          description: 'an L2 oracle accept is recorded',
          rule: {metric: 'l2_accepts', op: '>=', value: 1},
        },
      ],
    },
  ],
};

export const BUILTIN_PROFILES: Record<string, ProfileDefinition> = {
  full: FULL_PROFILE,
  light: LIGHT_PROFILE,
};

export function loadProfile(name: string, roots: string[] = []): ProfileDefinition {
  const builtin = BUILTIN_PROFILES[name];
  if (builtin) return cloneProfile(builtin);
  for (const root of roots) {
    const file = path.join(root, 'profiles', `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return validateProfile(raw, file);
  }
  throw new Error(
    `unknown profile: ${name} (place ${name}.json under a profiles/ directory or use full/light)`,
  );
}

export function profileRootsForTask(taskRoot: string): string[] {
  return [taskRoot, path.resolve(taskRoot, '..', '..'), path.join(process.cwd(), 'profiles')];
}

export function validateProfile(raw: unknown, source = 'profile'): ProfileDefinition {
  if (!raw || typeof raw !== 'object') throw new Error(`${source}: profile must be an object`);
  const profile = raw as ProfileDefinition;
  if (typeof profile.name !== 'string' || !profile.name) {
    throw new Error(`${source}: profile.name is required`);
  }
  if (!Array.isArray(profile.stages) || profile.stages.length === 0) {
    throw new Error(`${source}: profile.stages must be a non-empty array`);
  }
  const stageIds = new Set<string>();
  for (const stage of profile.stages) {
    if (!stage.id || typeof stage.id !== 'string') throw new Error(`${source}: stage id required`);
    if (stageIds.has(stage.id)) throw new Error(`${source}: duplicate stage ${stage.id}`);
    stageIds.add(stage.id);
    if (!Array.isArray(stage.requirements)) {
      throw new Error(`${source}: stage ${stage.id} requirements must be an array`);
    }
    const requirementIds = new Set<string>();
    for (const requirement of stage.requirements) {
      if (!requirement.id) throw new Error(`${source}: requirement id required`);
      if (requirementIds.has(requirement.id)) {
        throw new Error(`${source}: duplicate requirement ${stage.id}/${requirement.id}`);
      }
      requirementIds.add(requirement.id);
      if (requirement.kind !== 'evidence' && requirement.kind !== 'human') {
        throw new Error(`${source}: requirement ${stage.id}/${requirement.id} has invalid kind`);
      }
      if (requirement.kind === 'evidence') {
        if (!requirement.rule) {
          throw new Error(
            `${source}: evidence requirement ${stage.id}/${requirement.id} needs a rule`,
          );
        }
        if (!METRICS.has(requirement.rule.metric)) {
          throw new Error(
            `${source}: unknown metric ${requirement.rule.metric} in ${stage.id}/${requirement.id}`,
          );
        }
        if (!RULE_OPS.includes(requirement.rule.op)) {
          throw new Error(
            `${source}: unknown op ${requirement.rule.op} in ${stage.id}/${requirement.id}`,
          );
        }
      } else if (!requirement.attestation) {
        throw new Error(
          `${source}: human requirement ${stage.id}/${requirement.id} needs an attestation key`,
        );
      }
    }
  }
  return cloneProfile(profile);
}

export function gateMetrics(context: {
  config: TaskConfig;
  projection: TaskProjection;
  events: LedgerEvent[];
}): Record<string, number | boolean> {
  const completedRuns = context.projection.runs.filter(run => run['status'] === 'completed');
  const planned = new Map(
    context.events
      .filter(event => event.type === 'experiment.planned')
      .map(event => [String(event.payload['id']), event.payload]),
  );
  const completedDiscriminating = context.events.filter(event => {
    if (event.type !== 'experiment.completed') return false;
    const plan = planned.get(String(event.payload['id']));
    return plan?.['kind'] === 'discriminating';
  }).length;

  return {
    goal_set: context.config.goal.trim().length > 0,
    oracle_refs: context.config.oracle_refs.length,
    completed_runs: completedRuns.length,
    session_runs: completedRuns.filter(
      run => typeof run['session_id'] === 'string' && run['session_id'],
    ).length,
    total_hypotheses: context.projection.hypotheses.length,
    open_hypotheses: context.projection.hypotheses.filter(
      hypothesis => hypothesis.status === 'proposed' || hypothesis.status === 'testing',
    ).length,
    planned_experiments: context.projection.experiments.length,
    discriminating_plans: context.projection.experiments.filter(
      experiment => experiment.kind === 'discriminating' && experiment.targets.length >= 2,
    ).length,
    completed_discriminating: completedDiscriminating,
    has_frontier: context.projection.frontier !== null,
    l2_accepts: context.projection.oracle_results.filter(
      result => result['evidence_level'] === 'L2' && result['verdict'] === 'accept',
    ).length,
    stop_triggered: context.projection.stop.triggered,
    refuted_hypotheses: context.projection.hypotheses.filter(
      hypothesis => hypothesis.status === 'refuted',
    ).length,
    human_attestations: context.events.filter(
      event => event.type === 'human.decision' && event.payload['kind'] === 'gate_attestation',
    ).length,
  };
}

export function evaluateRule(
  rule: ProfileRule,
  metrics: Record<string, number | boolean>,
): boolean {
  const actual = metrics[rule.metric];
  if (actual === undefined) return false;
  switch (rule.op) {
    case '==':
      return actual === rule.value;
    case '!=':
      return actual !== rule.value;
    case '>=':
      return Number(actual) >= Number(rule.value);
    case '<=':
      return Number(actual) <= Number(rule.value);
    case '>':
      return Number(actual) > Number(rule.value);
    case '<':
      return Number(actual) < Number(rule.value);
    case 'in':
      return Array.isArray(rule.value) && rule.value.includes(actual);
    case 'exists':
      return actual !== null && actual !== undefined && actual !== false && actual !== 0;
    default:
      return false;
  }
}

function cloneProfile(profile: ProfileDefinition): ProfileDefinition {
  return JSON.parse(JSON.stringify(profile)) as ProfileDefinition;
}
