import {createHash} from 'node:crypto';
import fs from 'node:fs';

export type RunType = 'capture' | 'execute' | 'submit';
export type RunSide = 'reference' | 'candidate';
export type RunStatus = 'completed' | 'failed' | 'timeout' | 'blocked' | 'invalid';

export interface ComparabilityKeys {
  event_schema: string;
  instrumentation_hash: string;
  material_pair_hash?: string;
  material_hash?: string;
  focus_hash: string;
  comparison_policy_hash: string;
}

export interface TraceManifest {
  captured_at: string;
  event_schema: string;
  instrumentation_hash: string;
  target_script_hash: string;
  environment?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  task_id: string;
  iteration: number;
  repeat_index: number;
  type: RunType;
  side: RunSide;
  status: RunStatus;
  comparability: ComparabilityKeys;
  session_id?: string;
  reference_quality?: 'live_capture' | 'trace_file';
  baseline_group?: string;
  trace_manifest?: TraceManifest;
  code?: {
    target_fingerprint?: string[];
    target_script_hash?: string;
    env_version?: string;
  };
  artifacts?: Record<string, string>;
  result?: {
    output_digest?: string;
    oracle_verdict?: string | null;
  };
  created_at: string;
}

export type InvalidReason =
  | 'schema_mismatch'
  | 'instrumentation_mismatch'
  | 'stale_reference'
  | 'material_unpaired'
  | 'insufficient_baseline'
  | 'comparison_policy_mismatch';

export function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function sha256String(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function compareRuns(
  a: RunRecord,
  b: RunRecord,
): {comparable: boolean; reasons: InvalidReason[]} {
  const reasons: InvalidReason[] = [];
  if (a.comparability.event_schema !== b.comparability.event_schema) {
    reasons.push('schema_mismatch');
  }
  if (a.comparability.instrumentation_hash !== b.comparability.instrumentation_hash) {
    reasons.push('instrumentation_mismatch');
  }
  if (a.comparability.comparison_policy_hash !== b.comparability.comparison_policy_hash) {
    reasons.push('comparison_policy_mismatch');
  }
  const aPair = a.comparability.material_pair_hash ?? a.comparability.material_hash;
  const bPair = b.comparability.material_pair_hash ?? b.comparability.material_hash;
  if (!aPair || !bPair || aPair !== bPair) {
    reasons.push('material_unpaired');
  }
  return {comparable: reasons.length === 0, reasons};
}

export function checkStaleReference(
  reference: RunRecord,
  candidate: RunRecord,
): InvalidReason | null {
  if (!reference.trace_manifest) return null;
  const expected = reference.trace_manifest.target_script_hash;
  const actual = candidate.code?.target_script_hash;
  if (!actual) return 'stale_reference';
  if (expected !== actual) return 'stale_reference';
  return null;
}

export function validateBaseline(references: RunRecord[]): {
  ok: boolean;
  reason?: InvalidReason;
} {
  const valid = references.filter(r => r.status === 'completed');
  if (valid.length < 2) return {ok: false, reason: 'insufficient_baseline'};
  const first = valid[0];
  for (const ref of valid.slice(1)) {
    const {comparable} = compareRuns(first, ref);
    if (!comparable) return {ok: false, reason: 'insufficient_baseline'};
    if (
      ref.reference_quality !== first.reference_quality ||
      ref.trace_manifest?.instrumentation_hash !== first.trace_manifest?.instrumentation_hash ||
      ref.trace_manifest?.target_script_hash !== first.trace_manifest?.target_script_hash
    ) {
      return {ok: false, reason: 'insufficient_baseline'};
    }
  }
  return {ok: true};
}
