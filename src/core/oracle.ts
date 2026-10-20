export type VerdictClass =
  | 'accept'
  | 'reject'
  | 'replay_rejected'
  | 'transient'
  | 'indeterminate'
  | 'ambiguous'
  | 'unclassified';

export type EvidenceLevel = 'L0' | 'L1' | 'L2';

export type OracleKind = 'server_accept' | 'output_equality' | 'differential';

export interface OracleResponse {
  http_status: number;
  json?: unknown;
  error?: string;
  text?: string;
}

export interface ControlSample {
  ref: string;
  expected: 'accept' | 'reject' | 'replay_rejected';
  approved_by?: 'human' | null;
  validation_mode?: 'original_acceptance' | 'resubmit';
}

export interface OracleConfig {
  id: string;
  version: number;
  kind: OracleKind;
  scope: {
    endpoint: string;
    param: string;
    chain: 'browser' | 'offline' | 'hybrid';
  };
  submission?: {
    transport?: 'http' | 'browser';
    side_effect?: 'read_only' | 'write';
    authorization?: {
      required?: boolean;
      approver?: string;
      max_side_effect_calls?: number;
    };
    timeout_ms?: number;
    max_attempts?: number;
    rate_limit?: string;
  };
  verdict: Partial<Record<Exclude<VerdictClass, 'ambiguous' | 'unclassified'>, string[]>>;
  calibration: {
    positive: ControlSample[];
    negative_controls: ControlSample[];
    require: {
      positive_accept_rate: number;
      negative_reject_rate: number;
    };
  };
}

export interface ClassificationResult {
  verdict: VerdictClass;
  matched: Array<{ruleClass: string; expressions: string[]}>;
  reason: string;
}

export function classifyResponse(
  oracle: OracleConfig,
  response: OracleResponse,
): ClassificationResult {
  const matched: Array<{ruleClass: string; expressions: string[]}> = [];
  for (const [ruleClass, expressions] of Object.entries(oracle.verdict)) {
    if (!expressions || expressions.length === 0) continue;
    const ok = expressions.every(expr => evaluatePredicate(expr, response));
    if (ok) matched.push({ruleClass, expressions});
  }

  if (matched.length === 1) {
    return {
      verdict: matched[0].ruleClass as VerdictClass,
      matched,
      reason: `matched ${matched[0].ruleClass}`,
    };
  }
  if (matched.length > 1) {
    return {
      verdict: 'ambiguous',
      matched,
      reason: `multiple classes matched: ${matched.map(m => m.ruleClass).join(', ')}`,
    };
  }
  return {verdict: 'unclassified', matched, reason: 'no verdict class matched'};
}

export interface CalibrationResult {
  status: 'draft' | 'calibrated' | 'active' | 'invalidated' | 'unapproved_control';
  positiveApproved: boolean;
  positiveAcceptRate: number;
  negativeRejectRate: number;
  canL2: boolean;
  errors: string[];
}

export function evaluateCalibration(
  oracle: OracleConfig,
  observed: {positive: VerdictClass[]; negative: VerdictClass[]},
): CalibrationResult {
  const errors: string[] = [];
  const positiveApproved = oracle.calibration.positive.every(s => s.approved_by === 'human');
  if (!positiveApproved) {
    errors.push('positive control requires human approval');
  }

  const posTotal = observed.positive.length;
  const posAccepted = observed.positive.filter(v => v === 'accept').length;
  const negTotal = observed.negative.length;
  const negRejected = observed.negative.filter(
    v => v === 'reject' || v === 'replay_rejected',
  ).length;

  const positiveAcceptRate = posTotal === 0 ? 0 : posAccepted / posTotal;
  const negativeRejectRate = negTotal === 0 ? 0 : negRejected / negTotal;

  if (posTotal === 0) errors.push('no positive control observations');
  if (negTotal === 0) errors.push('no negative control observations');
  if (positiveAcceptRate < oracle.calibration.require.positive_accept_rate) {
    errors.push(`positive accept rate ${positiveAcceptRate} below required`);
  }
  if (negativeRejectRate < oracle.calibration.require.negative_reject_rate) {
    errors.push(`negative reject rate ${negativeRejectRate} below required`);
  }

  const controlsPassed = errors.length === 0;
  const canL2 = controlsPassed && positiveApproved && oracle.kind === 'server_accept';
  const status: CalibrationResult['status'] = !positiveApproved
    ? 'unapproved_control'
    : controlsPassed
      ? 'active'
      : 'invalidated';

  return {status, positiveApproved, positiveAcceptRate, negativeRejectRate, canL2, errors};
}

export function evidenceLevel(input: {
  managed: boolean;
  oracleKind: OracleKind;
  calibration: CalibrationResult;
  verdict: VerdictClass;
  referenceQuality?: 'live_capture' | 'trace_file';
}): EvidenceLevel {
  if (!input.managed) return 'L0';
  if (input.oracleKind === 'output_equality' || input.oracleKind === 'differential') {
    return 'L1';
  }
  if (input.verdict === 'accept' && input.calibration.canL2) return 'L2';
  if (input.calibration.positiveApproved) return 'L1';
  if (input.verdict === 'accept') return 'L1';
  return 'L0';
}

export function resolvePath(context: OracleResponse, dotted: string): unknown {
  const parts = dotted.split('.');
  let value: unknown = context;
  for (const part of parts) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function evaluatePredicate(expression: string, context: OracleResponse): boolean {
  const tokens = tokenize(expression);
  const parser = new PredicateParser(tokens);
  const ast = parser.parseExpression();
  if (!parser.atEnd()) {
    throw new Error(`unexpected token in predicate: ${expression}`);
  }
  return evalNode(ast, context);
}

type Token =
  | {kind: 'ident'; value: string}
  | {kind: 'number'; value: number}
  | {kind: 'string'; value: string}
  | {kind: 'op'; value: string}
  | {kind: 'and'}
  | {kind: 'lparen'}
  | {kind: 'rparen'}
  | {kind: 'lbracket'}
  | {kind: 'rbracket'}
  | {kind: 'comma'};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({kind: 'lparen'});
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({kind: 'rparen'});
      i++;
      continue;
    }
    if (c === '[') {
      tokens.push({kind: 'lbracket'});
      i++;
      continue;
    }
    if (c === ']') {
      tokens.push({kind: 'rbracket'});
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({kind: 'comma'});
      i++;
      continue;
    }
    if (c === '&' && input[i + 1] === '&') {
      tokens.push({kind: 'and'});
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== quote) {
        out += input[j];
        j++;
      }
      if (j >= input.length) throw new Error(`unterminated string in predicate: ${input}`);
      tokens.push({kind: 'string', value: out});
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      tokens.push({kind: 'number', value: Number(input.slice(i, j))});
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j])) j++;
      const word = input.slice(i, j);
      if (word === 'in') tokens.push({kind: 'op', value: 'in'});
      else tokens.push({kind: 'ident', value: word});
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
      tokens.push({kind: 'op', value: two});
      i += 2;
      continue;
    }
    if (c === '>' || c === '<') {
      tokens.push({kind: 'op', value: c});
      i++;
      continue;
    }
    throw new Error(`unexpected character '${c}' in predicate: ${input}`);
  }
  return tokens;
}

type Node =
  | {kind: 'and'; left: Node; right: Node}
  | {kind: 'compare'; path: string; op: string; value: unknown};

class PredicateParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  parseExpression(): Node {
    let left = this.parseTerm();
    while (!this.atEnd() && this.tokens[this.index].kind === 'and') {
      this.index++;
      const right = this.parseTerm();
      left = {kind: 'and', left, right};
    }
    return left;
  }

  private parseTerm(): Node {
    const token = this.tokens[this.index];
    if (!token) throw new Error('unexpected end of predicate');
    if (token.kind === 'lparen') {
      this.index++;
      const inner = this.parseExpression();
      this.expect('rparen');
      return inner;
    }
    if (token.kind !== 'ident') throw new Error('expected path in predicate');
    const path = token.value;
    this.index++;
    const opToken = this.tokens[this.index];
    if (!opToken || opToken.kind !== 'op') throw new Error(`expected operator after ${path}`);
    this.index++;
    const value = this.parseValue();
    return {kind: 'compare', path, op: opToken.value, value};
  }

  private parseValue(): unknown {
    const token = this.tokens[this.index];
    if (!token) throw new Error('expected value in predicate');
    if (token.kind === 'number' || token.kind === 'string') {
      this.index++;
      return token.value;
    }
    if (token.kind === 'lbracket') {
      this.index++;
      const values: unknown[] = [];
      while (!this.atEnd() && this.tokens[this.index].kind !== 'rbracket') {
        values.push(this.parseValue());
        if (!this.atEnd() && this.tokens[this.index].kind === 'comma') this.index++;
      }
      this.expect('rbracket');
      return values;
    }
    throw new Error('invalid value in predicate');
  }

  private expect(kind: Token['kind']): void {
    const token = this.tokens[this.index];
    if (!token || token.kind !== kind) throw new Error(`expected ${kind} in predicate`);
    this.index++;
  }
}

function evalNode(node: Node, context: OracleResponse): boolean {
  if (node.kind === 'and') return evalNode(node.left, context) && evalNode(node.right, context);
  const actual = resolvePath(context, node.path);
  return applyOperator(actual, node.op, node.value);
}

function applyOperator(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>=':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case '<=':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case '>':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case '<':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    default:
      throw new Error(`unsupported operator: ${op}`);
  }
}
