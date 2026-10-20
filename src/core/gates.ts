import type {LedgerEvent} from './ledger.js';
import {
  evaluateRule,
  gateMetrics,
  loadProfile,
  profileRootsForTask,
  type ProfileDefinition,
  type ProfileRequirement,
} from './profiles.js';
import type {TaskStore} from './task.js';

export type StageId = string;
export type FailureLayer = 'transport' | 'client_context' | 'content' | 'time' | 'session_state';

export const STAGE_ORDER: string[] = [
  'frame',
  'observe',
  'isolate',
  'hypothesize',
  'rebuild',
  'validate',
];

const FAILURE_LAYERS: FailureLayer[] = [
  'transport',
  'client_context',
  'content',
  'time',
  'session_state',
];

export interface GateEvaluation {
  stage: StageId;
  eligible: boolean;
  passed: string[];
  missing: string[];
  needs_human: string[];
}

export interface GateStatus {
  current_stage: StageId | null;
  profile: string;
  stages: Array<{
    id: StageId;
    name: string;
    status: 'accepted' | 'current' | 'pending';
    missing: string[];
    needs_human: string[];
  }>;
}

export interface GateClaimResult extends GateEvaluation {
  accepted: boolean;
}

export function profileFor(store: TaskStore): ProfileDefinition {
  return loadProfile(store.config.profile, profileRootsForTask(store.rootDir));
}

export function currentStage(store: TaskStore): StageId | null {
  const profile = profileFor(store);
  const accepted = acceptedStages(store.ledger.read());
  let current: StageId | null = profile.stages[0]?.id ?? null;
  for (const stage of profile.stages) {
    if (!accepted.has(stage.id)) break;
    const index = profile.stages.indexOf(stage);
    current = profile.stages[index + 1]?.id ?? null;
  }
  return current;
}

export function evaluateGate(store: TaskStore, stage: StageId): GateEvaluation {
  const profile = profileFor(store);
  const definition = profile.stages.find(item => item.id === stage);
  if (!definition) throw new Error(`unknown stage: ${stage}`);
  return evaluateRequirements(store, definition);
}

export function claimGate(
  store: TaskStore,
  stage: StageId,
  evidenceRefs: string[] = [],
): GateClaimResult {
  const current = currentStage(store);
  if (current === null) throw new Error('all gates already accepted');
  if (stage !== current) {
    throw new Error(`gate order violation: current stage is ${current}, requested ${stage}`);
  }
  const evaluation = evaluateGate(store, stage);
  store.ledger.append(
    'agent',
    'gate.claimed',
    {
      stage,
      evidence_refs: evidenceRefs,
      eligible: evaluation.eligible,
    },
    evidenceRefs,
  );
  store.ledger.append(
    'harness',
    'gate.verdict',
    {
      stage,
      accepted: evaluation.eligible,
      passed: evaluation.passed,
      missing: evaluation.missing,
      needs_human: evaluation.needs_human,
      evidence_refs: evidenceRefs,
    },
    evidenceRefs,
  );
  return {...evaluation, accepted: evaluation.eligible};
}

export function attestGate(
  store: TaskStore,
  input: {
    stage: StageId;
    requirement: string;
    statement: string;
    failureLayer?: FailureLayer;
  },
): void {
  if (!input.statement.trim()) throw new Error('attestation requires a statement');
  if (input.requirement === 'failure_layer') {
    if (!input.failureLayer || !FAILURE_LAYERS.includes(input.failureLayer)) {
      throw new Error(`failure_layer must be one of ${FAILURE_LAYERS.join(', ')}`);
    }
  }
  store.ledger.append('human', 'human.decision', {
    kind: 'gate_attestation',
    stage: input.stage,
    requirement: input.requirement,
    statement: input.statement,
    failure_layer: input.failureLayer,
  });
}

export function gateStatus(store: TaskStore): GateStatus {
  const profile = profileFor(store);
  const accepted = acceptedStages(store.ledger.read());
  const current = currentStage(store);
  return {
    current_stage: current,
    profile: store.config.profile,
    stages: profile.stages.map(definition => {
      const evaluation = evaluateRequirements(store, definition);
      return {
        id: definition.id,
        name: definition.name,
        status: accepted.has(definition.id)
          ? 'accepted'
          : definition.id === current
            ? 'current'
            : 'pending',
        missing: evaluation.missing,
        needs_human: evaluation.needs_human,
      };
    }),
  };
}

export function acceptedStages(events: LedgerEvent[]): Set<StageId> {
  return new Set(
    events
      .filter(event => event.type === 'gate.verdict' && event.payload['accepted'] === true)
      .map(event => event.payload['stage'] as StageId),
  );
}

function evaluateRequirements(
  store: TaskStore,
  definition: ProfileDefinition['stages'][number],
): GateEvaluation {
  const context = {
    config: store.config,
    projection: store.projection(),
    events: store.ledger.read(),
  };
  const metrics = gateMetrics(context);
  const passed: string[] = [];
  const missing: string[] = [];
  const needsHuman: string[] = [];
  for (const requirement of definition.requirements) {
    if (requirement.kind === 'human') {
      if (hasAttestation(context.events, definition.id, requirement)) passed.push(requirement.id);
      else needsHuman.push(requirement.id);
      continue;
    }
    if (requirement.rule && evaluateRule(requirement.rule, metrics)) passed.push(requirement.id);
    else missing.push(requirement.id);
  }
  return {
    stage: definition.id,
    eligible: missing.length === 0 && needsHuman.length === 0,
    passed,
    missing,
    needs_human: needsHuman,
  };
}

function hasAttestation(
  events: LedgerEvent[],
  stage: StageId,
  requirement: ProfileRequirement,
): boolean {
  return events.some(event => {
    if (event.type !== 'human.decision') return false;
    if (event.payload['kind'] !== 'gate_attestation') return false;
    if (event.payload['stage'] !== stage) return false;
    if (event.payload['requirement'] !== requirement.id) return false;
    if (requirement.attestation === 'failure_layer') {
      return FAILURE_LAYERS.includes(event.payload['failure_layer'] as FailureLayer);
    }
    return true;
  });
}
