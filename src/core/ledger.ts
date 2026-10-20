import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Actor = 'agent' | 'harness' | 'human';

export type LedgerEventType =
  | 'task.initialized'
  | 'hypothesis.proposed'
  | 'hypothesis.state_changed'
  | 'experiment.planned'
  | 'experiment.completed'
  | 'run.recorded'
  | 'divergence.computed'
  | 'gate.claimed'
  | 'gate.verdict'
  | 'oracle.result'
  | 'evidence.recorded'
  | 'stop.triggered'
  | 'stop.overridden'
  | 'human.decision';

export interface LedgerEvent {
  seq: number;
  ts: string;
  task_id: string;
  actor: Actor;
  type: LedgerEventType;
  payload: Record<string, unknown>;
  refs: string[];
  prev_hash: string | null;
  hash: string;
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = normalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function hashPayload(event: Omit<LedgerEvent, 'hash'>): string {
  return sha256(canonicalJson(event));
}

export class Ledger {
  private cache: LedgerEvent[];

  private constructor(
    private readonly filePath: string,
    private readonly taskId: string,
    events: LedgerEvent[],
  ) {
    this.cache = events;
  }

  static open(filePath: string, taskId: string): Ledger {
    fs.mkdirSync(path.dirname(filePath), {recursive: true, mode: 0o700});
    const events = Ledger.readFile(filePath);
    return new Ledger(filePath, taskId, events);
  }

  static readFile(filePath: string): LedgerEvent[] {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const events: LedgerEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as LedgerEvent);
    }
    return events;
  }

  get taskIdValue(): string {
    return this.taskId;
  }

  get file(): string {
    return this.filePath;
  }

  read(): LedgerEvent[] {
    return [...this.cache];
  }

  append(
    actor: Actor,
    type: LedgerEventType,
    payload: Record<string, unknown>,
    refs: string[] = [],
  ): LedgerEvent {
    const prev = this.cache.at(-1);
    const base: Omit<LedgerEvent, 'hash'> = {
      seq: (prev?.seq ?? 0) + 1,
      ts: new Date().toISOString(),
      task_id: this.taskId,
      actor,
      type,
      payload,
      refs,
      prev_hash: prev?.hash ?? null,
    };
    const normalized = JSON.parse(canonicalJson(base)) as Omit<LedgerEvent, 'hash'>;
    const event: LedgerEvent = {...normalized, hash: hashPayload(normalized)};
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, {encoding: 'utf8', mode: 0o600});
    this.cache.push(event);
    return event;
  }

  verify(): {ok: boolean; errors: string[]} {
    const errors: string[] = [];
    let prevHash: string | null = null;
    let expectedSeq = 1;
    for (const event of this.cache) {
      if (event.seq !== expectedSeq) {
        errors.push(`seq mismatch at event ${event.seq}: expected ${expectedSeq}`);
      }
      if ((event.prev_hash ?? null) !== prevHash) {
        errors.push(`prev_hash mismatch at seq ${event.seq}`);
      }
      const {hash, ...base} = event;
      if (hashPayload(base) !== hash) {
        errors.push(`hash mismatch at seq ${event.seq}`);
      }
      prevHash = hash;
      expectedSeq++;
    }
    return {ok: errors.length === 0, errors};
  }
}
