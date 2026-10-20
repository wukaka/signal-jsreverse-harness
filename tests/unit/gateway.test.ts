import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

import {TaskStore, taskDir} from '../../src/core/task.js';
import {registerGatewayTools, type Upstream} from '../../src/mcp/gateway.js';
import {createHarnessServerBundle} from '../../src/mcp/server.js';

function textOf(result: unknown): string {
  const content = (result as {content?: Array<{type: string; text?: string}>}).content ?? [];
  return content.find(item => item.type === 'text')?.text ?? '';
}

async function withGateway(
  run: (client: Client, store: TaskStore) => Promise<void>,
  upstreamOverride?: Partial<Upstream>,
): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-gateway-'));
  try {
    const store = TaskStore.init(taskDir(workspace, 'test'), {
      task_id: 'test',
      goal: 'gateway test',
      profile: 'full',
      chain: 'offline',
      oracle_refs: [],
      budget: {submissions: 0, wall_time_min: 10},
    });
    const bundle = createHarnessServerBundle({workspaceRoot: workspace, taskId: 'test'});
    const calls: Array<{name: string; arguments?: Record<string, unknown>}> = [];
    const tools = [
      {name: 'list_pages', description: 'List browser pages'},
      {name: 'evaluate_script', description: 'Evaluate JS in page'},
    ];
    const upstream: Upstream = {
      tools,
      client: {
        listTools: async () => ({tools}),
        callTool: async params => {
          calls.push(params);
          return {content: [{type: 'text', text: 'ok'}]};
        },
      },
      close: async () => {},
      ...upstreamOverride,
    };
    registerGatewayTools(bundle.server, store, upstream);

    const client = new Client({name: 'test-client', version: '0.0.0'}, {capabilities: {}});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bundle.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await run(client, store);
      assert.ok(calls.length >= 0);
    } finally {
      await client.close();
      await bundle.server.close();
    }
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
}

test('gateway lists and proxies upstream tools as L0 evidence', async () => {
  await withGateway(async (client, store) => {
    const listed = await client.callTool({name: 'gateway_list_tools', arguments: {}});
    const payload = JSON.parse(textOf(listed)) as {tools: Array<{name: string}>};
    assert.deepEqual(
      payload.tools.map(tool => tool.name),
      ['list_pages', 'evaluate_script'],
    );

    const called = await client.callTool({
      name: 'gateway_call',
      arguments: {tool: 'list_pages', args: {limit: 5}, experiment_id: 'e-1'},
    });
    assert.equal(called.isError, undefined);
    assert.equal(textOf(called), 'ok');

    const evidence = store
      .projection()
      .evidence.filter(item => item['source'] === 'gateway' && item['tool'] === 'list_pages');
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]['strength'], 'L0');
    assert.equal(evidence[0]['experiment_id'], 'e-1');
    assert.ok(fs.existsSync(String(evidence[0]['artifact'])));
  });
});

test('gateway rejects unknown upstream tools without recording evidence', async () => {
  await withGateway(async (client, store) => {
    const result = await client.callTool({
      name: 'gateway_call',
      arguments: {tool: 'not_a_tool', args: {}},
    });
    assert.equal(result.isError, true);
    assert.equal(
      store.projection().evidence.filter(item => item['source'] === 'gateway').length,
      0,
    );
  });
});

test('gateway records upstream failures as L0 evidence', async () => {
  await withGateway(
    async (client, store) => {
      const result = await client.callTool({
        name: 'gateway_call',
        arguments: {tool: 'list_pages', args: {}},
      });
      assert.equal(result.isError, true);
      const evidence = store
        .projection()
        .evidence.filter(item => item['source'] === 'gateway' && item['error']);
      assert.equal(evidence.length, 1);
      assert.match(String(evidence[0]['error']), /upstream exploded/);
    },
    {
      client: {
        listTools: async () => ({tools: [{name: 'list_pages'}]}),
        callTool: async () => {
          throw new Error('upstream exploded');
        },
      },
    },
  );
});
