import {Ledger, type LedgerEvent} from './ledger.js';

export type HypothesisStatus = 'proposed' | 'testing' | 'supported' | 'refuted' | 'withdrawn';
export type ExperimentKind = 'probe' | 'discriminating' | 'verification';

export interface Hypothesis {
  id: string;
  claim: string;
  falsifier: string;
  status: HypothesisStatus;
  bound_experiment?: string;
}

export interface Experiment {
  id: string;
  kind: ExperimentKind;
  targets: string[];
  variable?: string;
  adapter?: string;
  config?: Record<string, unknown>;
}

export interface ExperimentState {
  hypotheses: Record<string, Hypothesis>;
  experiments: Record<string, Experiment>;
  streak: number;
  deferralsConsumed: number;
  probeStagnation: number;
  stopTriggered: boolean;
  stopReason: string | null;
  pendingDeferrals: string[];
}

export interface ExperimentOptions {
  streakThreshold?: number;
  maxDeferrals?: number;
  probeStagnationThreshold?: number;
}

const DEFAULTS: Required<ExperimentOptions> = {
  streakThreshold: 2,
  maxDeferrals: 2,
  probeStagnationThreshold: 2,
};

export function emptyState(): ExperimentState {
  return {
    hypotheses: {},
    experiments: {},
    streak: 0,
    deferralsConsumed: 0,
    probeStagnation: 0,
    stopTriggered: false,
    stopReason: null,
    pendingDeferrals: [],
  };
}

export class ExperimentBook {
  private stateValue: ExperimentState;
  private optionsValue: Required<ExperimentOptions>;
  private hypothesisCounter = 0;
  private experimentCounter = 0;

  constructor(
    private readonly ledger: Ledger,
    options: ExperimentOptions = {},
  ) {
    this.optionsValue = {...DEFAULTS, ...options};
    this.stateValue = replay(ledger.read(), this.optionsValue).state;
    this.hypothesisCounter = Object.keys(this.stateValue.hypotheses).length;
    this.experimentCounter = Object.keys(this.stateValue.experiments).length;
  }

  get state(): ExperimentState {
    return structuredClone(this.stateValue);
  }

  canRunExperiment(): boolean {
    return !this.stateValue.stopTriggered;
  }

  proposeHypothesis(input: {
    claim: string;
    falsifier: string;
    boundExperiment?: string;
  }): Hypothesis {
    const id = `h-${++this.hypothesisCounter}`;
    const hypothesis: Hypothesis = {
      id,
      claim: input.claim,
      falsifier: input.falsifier,
      status: 'proposed',
      bound_experiment: input.boundExperiment,
    };
    this.ledger.append('agent', 'hypothesis.proposed', {...hypothesis});
    this.stateValue = replay(this.ledger.read(), this.optionsValue).state;
    return hypothesis;
  }

  planExperiment(input: {
    kind: ExperimentKind;
    targets: string[];
    variable?: string;
    adapter?: string;
    config?: Record<string, unknown>;
  }): Experiment {
    const id = `e-${++this.experimentCounter}`;
    const experiment: Experiment = {
      id,
      kind: input.kind,
      targets: input.targets,
      variable: input.variable,
      adapter: input.adapter,
      config: input.config,
    };
    this.ledger.append('agent', 'experiment.planned', {...experiment});
    this.stateValue = replay(this.ledger.read(), this.optionsValue).state;
    return experiment;
  }

  completeExperiment(input: {
    id: string;
    gain: 0 | 1;
    uncertaintyChanged?: boolean;
  }): ExperimentState {
    if (this.stateValue.stopTriggered) {
      throw new Error('stop already triggered; append stop.overridden before new experiments');
    }
    const experiment = this.stateValue.experiments[input.id];
    if (!experiment) throw new Error(`unknown experiment: ${input.id}`);
    this.ledger.append('harness', 'experiment.completed', {
      id: input.id,
      kind: experiment.kind,
      targets: experiment.targets,
      gain: input.gain,
      uncertainty_changed: input.uncertaintyChanged ?? input.gain === 1,
    });
    this.stateValue = replay(this.ledger.read(), this.optionsValue).state;
    this.persistStop();
    return this.state;
  }

  completeProbe(input: {id: string; uncertaintyChanged: boolean}): ExperimentState {
    if (this.stateValue.stopTriggered) {
      throw new Error('stop already triggered; append stop.overridden before new probes');
    }
    this.ledger.append('harness', 'experiment.completed', {
      id: input.id,
      kind: 'probe',
      uncertainty_changed: input.uncertaintyChanged,
      gain: 0,
    });
    this.stateValue = replay(this.ledger.read(), this.optionsValue).state;
    this.persistStop();
    return this.state;
  }

  private persistStop(): void {
    if (!this.stateValue.stopTriggered) return;
    const last = this.ledger.read().at(-1);
    if (last?.type === 'stop.triggered') return;
    this.ledger.append('harness', 'stop.triggered', {
      reason: this.stateValue.stopReason,
      streak: this.stateValue.streak,
      deferrals_consumed: this.stateValue.deferralsConsumed,
    });
  }

  override(reason: string): ExperimentState {
    this.ledger.append('human', 'stop.overridden', {reason});
    this.stateValue = replay(this.ledger.read(), this.optionsValue).state;
    return this.state;
  }
}

export function replay(
  events: LedgerEvent[],
  options: Required<ExperimentOptions> = DEFAULTS,
): {state: ExperimentState} {
  const state = emptyState();
  for (const event of events) {
    if (event.type === 'hypothesis.proposed') {
      const hypothesis = event.payload as unknown as Hypothesis;
      state.hypotheses[hypothesis.id] = {...hypothesis};
      const bound = hypothesis.bound_experiment;
      if (bound) {
        const experiment = state.experiments[bound];
        if (experiment && experiment.kind === 'discriminating') {
          state.pendingDeferrals.push(bound);
        }
      }
      continue;
    }
    if (event.type === 'experiment.planned') {
      const experiment = event.payload as unknown as Experiment;
      state.experiments[experiment.id] = {...experiment};
      continue;
    }
    if (event.type === 'experiment.completed') {
      applyCompletion(state, event, options);
      continue;
    }
    if (event.type === 'stop.triggered') {
      state.stopTriggered = true;
      state.stopReason = String(event.payload.reason ?? 'stop');
      continue;
    }
    if (event.type === 'stop.overridden') {
      state.stopTriggered = false;
      state.stopReason = null;
      state.streak = 0;
      state.deferralsConsumed = 0;
      state.probeStagnation = 0;
      state.pendingDeferrals = [];
    }
  }
  return {state};
}

function applyCompletion(
  state: ExperimentState,
  event: LedgerEvent,
  options: Required<ExperimentOptions>,
): void {
  const payload = event.payload as {
    id: string;
    kind: ExperimentKind;
    gain?: 0 | 1;
    uncertainty_changed?: boolean;
  };
  const experiment = state.experiments[payload.id];

  if (payload.kind === 'probe') {
    if (payload.uncertainty_changed) {
      state.probeStagnation = 0;
    } else {
      state.probeStagnation++;
      if (state.probeStagnation >= options.probeStagnationThreshold) {
        state.streak++;
        state.probeStagnation = 0;
        maybeStop(state, options);
      }
    }
    return;
  }

  const gain = payload.gain ?? 0;
  const deferralIndex = state.pendingDeferrals.indexOf(payload.id);
  const hadDeferral = deferralIndex >= 0;

  if (gain === 1) {
    state.streak = 0;
    if (hadDeferral) state.pendingDeferrals.splice(deferralIndex, 1);
    return;
  }

  if (hadDeferral) {
    state.pendingDeferrals.splice(deferralIndex, 1);
    state.deferralsConsumed++;
    if (state.deferralsConsumed >= options.maxDeferrals) {
      state.stopTriggered = true;
      state.stopReason = `deferrals_exhausted:${state.deferralsConsumed}`;
      return;
    }
  } else {
    state.streak++;
    maybeStop(state, options);
  }

  if (!experiment) return;
}

function maybeStop(state: ExperimentState, options: Required<ExperimentOptions>): void {
  if (state.streak >= options.streakThreshold && !state.stopTriggered) {
    state.stopTriggered = true;
    state.stopReason = `no_gain_streak:${state.streak}`;
  }
}
