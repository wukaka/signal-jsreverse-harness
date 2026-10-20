import fs from 'node:fs';
import path from 'node:path';

import {canonicalJson, sha256} from './ledger.js';
import type {OracleConfig} from './oracle.js';

export interface HttpRequestSpec {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpSubmitResult {
  sent: boolean;
  http_status: number;
  json?: unknown;
  text?: string;
  error?: string;
  duration_ms: number;
  request_ref: string;
  response_ref: string;
}

export interface HttpSubmitOptions {
  oracle: OracleConfig;
  request: HttpRequestSpec;
  allowLive: boolean;
  authorizationRef?: string;
  artifactDir?: string;
  timeoutMs?: number;
  now?: () => number;
}

const lastSubmitAt = new Map<string, number>();

export async function submitHttp(options: HttpSubmitOptions): Promise<HttpSubmitResult> {
  const method = (options.request.method ?? 'GET').toUpperCase();
  const timeoutMs = options.timeoutMs ?? options.oracle.submission?.timeout_ms ?? 10_000;
  const sideEffect = options.oracle.submission?.side_effect ?? 'read_only';

  if (!options.allowLive) {
    throw new Error('live submission is disabled; start the harness with --allow-live');
  }
  if (sideEffect === 'write' && !options.authorizationRef) {
    throw new Error('write submission requires authorization_ref');
  }
  assertTarget(options.oracle, method, options.request.url);
  enforceRateLimit(options.oracle, options.now ?? Date.now);

  const requestRef = sha256(canonicalJson(options.request));
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(options.request.url, {
      method,
      headers: options.request.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : options.request.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = undefined;
    }
    const result: HttpSubmitResult = {
      sent: true,
      http_status: response.status,
      json,
      text,
      duration_ms: Date.now() - started,
      request_ref: requestRef,
      response_ref: sha256(canonicalJson({status: response.status, text})),
    };
    persistArtifacts(options.artifactDir, options.request, result);
    return result;
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? 'TIMEOUT' : (error as Error).message;
    const result: HttpSubmitResult = {
      sent: true,
      http_status: 0,
      error: message,
      duration_ms: Date.now() - started,
      request_ref: requestRef,
      response_ref: sha256(canonicalJson({error: message})),
    };
    persistArtifacts(options.artifactDir, options.request, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function assertTarget(oracle: OracleConfig, method: string, url: string): void {
  const [scopeMethod, scopeUrl] = oracle.scope.endpoint.split(/\s+/, 2);
  if (scopeMethod && scopeMethod.toUpperCase() !== method) {
    throw new Error(`method mismatch: expected ${scopeMethod}, got ${method}`);
  }
  if (scopeUrl) {
    const expected = new URL(scopeUrl);
    const actual = new URL(url);
    if (expected.origin !== actual.origin || expected.pathname !== actual.pathname) {
      throw new Error(
        `target mismatch: expected ${expected.origin}${expected.pathname}, got ${actual.origin}${actual.pathname}`,
      );
    }
  }
}

function enforceRateLimit(oracle: OracleConfig, now: () => number): void {
  const rule = oracle.submission?.rate_limit;
  if (!rule) return;
  const match = /^(\d+)\/(s|m|h)$/.exec(rule);
  if (!match) throw new Error(`invalid rate_limit: ${rule}`);
  const count = Number(match[1]);
  const windowMs = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  const interval = windowMs / count;
  const last = lastSubmitAt.get(oracle.id) ?? 0;
  const elapsed = now() - last;
  if (elapsed < interval) {
    throw new Error(`rate limited: retry in ${Math.ceil(interval - elapsed)}ms`);
  }
  lastSubmitAt.set(oracle.id, now());
}

function persistArtifacts(
  artifactDir: string | undefined,
  request: HttpRequestSpec,
  result: HttpSubmitResult,
): void {
  if (!artifactDir) return;
  fs.mkdirSync(artifactDir, {recursive: true, mode: 0o700});
  fs.writeFileSync(
    path.join(artifactDir, 'request.json'),
    JSON.stringify(request, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(artifactDir, 'response.json'),
    JSON.stringify({status: result.http_status, body: result.text, json: result.json}, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(artifactDir, 'meta.json'), JSON.stringify(result, null, 2), 'utf8');
}
