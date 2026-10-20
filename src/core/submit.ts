import {canonicalJson, Ledger, sha256, type Actor} from './ledger.js';
import type {HttpSubmitResult} from './http-submitter.js';
import {
  classifyResponse,
  evidenceLevel,
  type CalibrationResult,
  type EvidenceLevel,
  type OracleConfig,
  type OracleResponse,
  type VerdictClass,
} from './oracle.js';

export interface SubmissionRecord {
  id: string;
  oracle_id: string;
  run_id: string;
  managed: boolean;
  transport: 'recorded' | 'live' | 'observation';
  verdict: VerdictClass;
  evidence_level: EvidenceLevel;
  response_ref: string;
  authorization_ref: string | null;
  created_at: string;
}

export class SubmitService {
  constructor(
    private readonly ledger: Ledger,
    private readonly taskId: string,
  ) {}

  submitManaged(input: {
    oracle: OracleConfig;
    calibration: CalibrationResult;
    response: OracleResponse;
    runId: string;
    transport?: 'recorded' | 'live';
    authorizationRef?: string;
  }): SubmissionRecord {
    const transport = input.transport ?? 'recorded';
    if (transport === 'live' && !input.authorizationRef) {
      throw new Error('live submission requires authorization_ref');
    }
    return this.record({
      oracle: input.oracle,
      calibration: input.calibration,
      response: input.response,
      runId: input.runId,
      managed: true,
      transport,
      authorizationRef: input.authorizationRef ?? null,
      actor: 'harness',
    });
  }

  submitLive(input: {
    oracle: OracleConfig;
    calibration: CalibrationResult;
    http: HttpSubmitResult;
    runId: string;
    authorizationRef?: string;
  }): SubmissionRecord {
    return this.record({
      oracle: input.oracle,
      calibration: input.calibration,
      response: {
        http_status: input.http.http_status,
        json: input.http.json,
        text: input.http.text,
        error: input.http.error,
      },
      runId: input.runId,
      managed: true,
      transport: 'live',
      authorizationRef: input.authorizationRef ?? null,
      actor: 'harness',
    });
  }

  recordObservation(input: {
    oracle: OracleConfig;
    calibration: CalibrationResult;
    response: OracleResponse;
    runId: string;
    actor?: Actor;
  }): SubmissionRecord {
    return this.record({
      oracle: input.oracle,
      calibration: input.calibration,
      response: input.response,
      runId: input.runId,
      managed: false,
      transport: 'observation',
      authorizationRef: null,
      actor: input.actor ?? 'agent',
    });
  }

  private record(input: {
    oracle: OracleConfig;
    calibration: CalibrationResult;
    response: OracleResponse;
    runId: string;
    managed: boolean;
    transport: SubmissionRecord['transport'];
    authorizationRef: string | null;
    actor: Actor;
  }): SubmissionRecord {
    const classification = classifyResponse(input.oracle, input.response);
    const level = evidenceLevel({
      managed: input.managed,
      oracleKind: input.oracle.kind,
      calibration: input.calibration,
      verdict: classification.verdict,
    });
    const responseRef = sha256(canonicalJson(input.response));
    const record: SubmissionRecord = {
      id: `sub-${this.ledger.read().length + 1}`,
      oracle_id: input.oracle.id,
      run_id: input.runId,
      managed: input.managed,
      transport: input.transport,
      verdict: classification.verdict,
      evidence_level: level,
      response_ref: responseRef,
      authorization_ref: input.authorizationRef,
      created_at: new Date().toISOString(),
    };

    this.ledger.append(
      input.actor,
      'oracle.result',
      {
        ...record,
        matched_rules: classification.matched,
        reason: classification.reason,
      },
      [responseRef, input.runId],
    );

    return record;
  }
}
