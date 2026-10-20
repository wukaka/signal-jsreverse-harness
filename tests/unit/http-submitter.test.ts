import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {submitHttp} from '../../src/core/http-submitter.js';
import {classifyResponse, type OracleConfig} from '../../src/core/oracle.js';

function oracleFor(port: number, id: string, overrides: Partial<OracleConfig> = {}): OracleConfig {
  return {
    id,
    version: 1,
    kind: 'server_accept',
    scope: {endpoint: `POST http://127.0.0.1:${port}/verify`, param: 'sig', chain: 'offline'},
    submission: {
      transport: 'http',
      side_effect: 'read_only',
      timeout_ms: 2000,
      rate_limit: '1/s',
    },
    verdict: {
      accept: ['http_status == 200', 'json.status == 1'],
      reject: ['json.error.code == 121079'],
    },
    calibration: {
      positive: [],
      negative_controls: [],
      require: {positive_accept_rate: 1, negative_reject_rate: 1},
    },
    ...overrides,
  };
}

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    await run(address.port);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('live submission is disabled by default', async () => {
  await assert.rejects(
    submitHttp({
      oracle: oracleFor(1, 'disabled'),
      request: {url: 'http://127.0.0.1:1/verify', method: 'POST'},
      allowLive: false,
    }),
    /disabled/,
  );
});

test('submit classifies a recorded HTTP response as accept', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({status: 1}));
    },
    async port => {
      const oracle = oracleFor(port, `accept-${port}`);
      const result = await submitHttp({
        oracle,
        request: {url: `http://127.0.0.1:${port}/verify`, method: 'POST', body: 'x=1'},
        allowLive: true,
      });
      assert.equal(result.sent, true);
      assert.equal(result.http_status, 200);
      assert.equal(classifyResponse(oracle, result).verdict, 'accept');
    },
  );
});

test('write submission requires authorization', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"status":1}');
    },
    async port => {
      const oracle = oracleFor(port, `write-${port}`, {
        submission: {transport: 'http', side_effect: 'write', timeout_ms: 2000},
      });
      await assert.rejects(
        submitHttp({
          oracle,
          request: {url: `http://127.0.0.1:${port}/verify`, method: 'POST'},
          allowLive: true,
        }),
        /authorization_ref/,
      );
    },
  );
});

test('rate limit rejects a second immediate submission', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"status":1}');
    },
    async port => {
      const oracle = oracleFor(port, `rate-${port}`);
      const request = {url: `http://127.0.0.1:${port}/verify`, method: 'POST', body: 'x=1'};
      await submitHttp({oracle, request, allowLive: true});
      await assert.rejects(submitHttp({oracle, request, allowLive: true}), /rate limited/);
    },
  );
});

test('target mismatch is rejected before sending', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      res.end();
    },
    async port => {
      const oracle = oracleFor(port, `target-${port}`);
      await assert.rejects(
        submitHttp({
          oracle,
          request: {url: `http://127.0.0.1:${port}/other`, method: 'POST'},
          allowLive: true,
        }),
        /target mismatch/,
      );
    },
  );
});
