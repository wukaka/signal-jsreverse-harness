import {canonicalJson, sha256} from './ledger.js';

export type EventKind = 'call' | 'return' | 'read' | 'write' | 'error' | 'output';

export interface SemanticEvent {
  lane: string;
  seq: number;
  kind: EventKind;
  symbol: string;
  site: string;
  value_hash?: string;
  coverage?: 'full' | 'partial';
  source?: 'target' | 'harness';
}

export interface Trace {
  run_id: string;
  events: SemanticEvent[];
}

export type Classification =
  | 'missing_in_candidate'
  | 'extra_in_candidate'
  | 'value_mismatch'
  | 'shape_mismatch'
  | 'coverage_gap';

export interface Divergence {
  index: number;
  lane: string;
  symbol: string;
  site: string;
  kind: EventKind;
  classification: Classification;
}

export type DivergenceVerdict =
  | 'diverged'
  | 'no_divergence'
  | 'undetected_divergence'
  | 'insufficient_coverage'
  | 'insufficient_baseline';

export interface DivergenceResult {
  frontier: Divergence | null;
  noise_signatures: string[];
  meaningful: Divergence[];
  candidate: Divergence[];
  coverage_gaps: string[];
  verdict: DivergenceVerdict;
}

export interface CompareOptions {
  k?: number;
  r?: number;
  required_symbols?: string[];
  volatile_symbols?: string[];
  outputs_equal?: boolean;
}

export function eventValueHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function flattenEnvEvents(env: Record<string, unknown>, runId: string): Trace {
  const events: SemanticEvent[] = [];
  let seq = 0;
  const walk = (prefix: string, value: unknown) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prefixDepth(prefix) < 2
    ) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        walk(`${prefix}.${key}`, (value as Record<string, unknown>)[key]);
      }
      return;
    }
    seq++;
    events.push({
      lane: 'main',
      seq,
      kind: 'read',
      symbol: `env.${prefix}`,
      site: 'env',
      value_hash: eventValueHash(value),
      coverage: 'full',
      source: 'target',
    });
  };
  for (const key of Object.keys(env)) walk(key, env[key]);
  return {run_id: runId, events};
}

function prefixDepth(prefix: string): number {
  return prefix.split('.').length - 1;
}

export function compareTraces(
  references: Trace[],
  candidates: Trace[],
  options: CompareOptions = {},
): DivergenceResult {
  if (references.length < 2) {
    return {
      frontier: null,
      noise_signatures: [],
      meaningful: [],
      candidate: [],
      coverage_gaps: [],
      verdict: 'insufficient_baseline',
    };
  }

  const volatile = new Set(options.volatile_symbols ?? []);
  const noise = collectNoiseSignatures(references[0], references[1], volatile);
  const coverageGaps = checkCoverage(references[0], candidates[0], options.required_symbols ?? []);
  const perCandidate = candidates.map(candidate =>
    diffTraces(references[0], candidate, volatile).filter(d => !noise.has(signatureOf(d))),
  );

  const r = options.r ?? Math.min(2, Math.max(1, candidates.length));
  const counts = new Map<string, {divergence: Divergence; count: number}>();
  for (const divergences of perCandidate) {
    const seen = new Set<string>();
    for (const d of divergences) {
      const sig = signatureOf(d);
      if (seen.has(sig)) continue;
      seen.add(sig);
      const existing = counts.get(sig);
      if (existing) existing.count++;
      else counts.set(sig, {divergence: d, count: 1});
    }
  }

  const meaningful = [...counts.values()]
    .filter(entry => entry.count >= r)
    .map(entry => entry.divergence)
    .sort((a, b) => a.index - b.index);

  const allCandidate = perCandidate.flat().sort((a, b) => a.index - b.index);

  if (coverageGaps.length > 0) {
    return {
      frontier: meaningful[0] ?? null,
      noise_signatures: [...noise],
      meaningful,
      candidate: allCandidate,
      coverage_gaps: coverageGaps,
      verdict: 'insufficient_coverage',
    };
  }

  if (meaningful.length > 0) {
    return {
      frontier: meaningful[0],
      noise_signatures: [...noise],
      meaningful,
      candidate: allCandidate,
      coverage_gaps: [],
      verdict: 'diverged',
    };
  }

  if (options.outputs_equal === false) {
    return {
      frontier: null,
      noise_signatures: [...noise],
      meaningful: [],
      candidate: allCandidate,
      coverage_gaps: [],
      verdict: 'undetected_divergence',
    };
  }

  return {
    frontier: null,
    noise_signatures: [...noise],
    meaningful: [],
    candidate: allCandidate,
    coverage_gaps: [],
    verdict: 'no_divergence',
  };
}

export function signatureOf(d: Divergence): string {
  return `${d.lane}|${d.symbol}|${d.site}|${d.classification}`;
}

function collectNoiseSignatures(a: Trace, b: Trace, volatile: Set<string>): Set<string> {
  return new Set(diffTraces(a, b, volatile).map(signatureOf));
}

function diffTraces(
  reference: Trace,
  candidate: Trace,
  volatile: Set<string> = new Set(),
): Divergence[] {
  const refEvents = reference.events.filter(e => e.source !== 'harness');
  const candEvents = candidate.events.filter(e => e.source !== 'harness');
  const divergent: Divergence[] = [];

  const buckets = new Map<string, SemanticEvent[]>();
  for (const event of candEvents) {
    const key = structuralKey(event);
    const list = buckets.get(key) ?? [];
    list.push(event);
    buckets.set(key, list);
  }
  const cursors = new Map<string, number>();

  refEvents.forEach((ref, index) => {
    const key = structuralKey(ref);
    const list = buckets.get(key) ?? [];
    const cursor = cursors.get(key) ?? 0;
    const counterpart = list[cursor];
    if (!counterpart) {
      divergent.push(toDivergence(ref, index, 'missing_in_candidate'));
      return;
    }
    cursors.set(key, cursor + 1);
    if (
      ref.value_hash &&
      counterpart.value_hash &&
      ref.value_hash !== counterpart.value_hash &&
      !volatile.has(ref.symbol)
    ) {
      divergent.push(toDivergence(ref, index, 'value_mismatch'));
    }
  });

  for (const [key, list] of buckets) {
    const consumed = cursors.get(key) ?? 0;
    for (const extra of list.slice(consumed)) {
      divergent.push(toDivergence(extra, refEvents.length, 'extra_in_candidate'));
    }
  }

  return divergent;
}

function structuralKey(event: SemanticEvent): string {
  return `${event.lane}|${event.kind}|${event.symbol}|${event.site}`;
}

function toDivergence(
  event: SemanticEvent,
  index: number,
  classification: Classification,
): Divergence {
  return {
    index,
    lane: event.lane,
    symbol: event.symbol,
    site: event.site,
    kind: event.kind,
    classification,
  };
}

function checkCoverage(
  reference: Trace,
  candidate: Trace | undefined,
  requiredSymbols: string[],
): string[] {
  if (!candidate) return requiredSymbols.length > 0 ? [...requiredSymbols] : [];
  const refSymbols = new Set(reference.events.map(e => e.symbol));
  const candSymbols = new Set(candidate.events.map(e => e.symbol));
  const gaps: string[] = [];
  for (const symbol of requiredSymbols) {
    if (!refSymbols.has(symbol) || !candSymbols.has(symbol)) gaps.push(symbol);
  }
  for (const event of candidate.events) {
    if (event.coverage === 'partial' && requiredSymbols.includes(event.symbol)) {
      if (!gaps.includes(event.symbol)) gaps.push(event.symbol);
    }
  }
  return [...new Set(gaps)];
}
