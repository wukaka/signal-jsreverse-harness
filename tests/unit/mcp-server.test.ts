import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

import {TaskStore, taskDir} from '../../src/core/task.js';
import {createHarnessServer} from '../../src/mcp/server.js';

async function withClient(
  run: (client: Client, workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigrev-mcp-'));
  try {
    TaskStore.init(taskDir(workspace, 'test'), {
      task_id: 'test',
      goal: 'mcp test',
      profile: 'full',
      chain: 'offline',
      oracle_refs: [],
      budget: {submissions: 0, wall_time_min: 10},
    });
    const server = createHarnessServer({workspaceRoot: workspace, taskId: 'test'});
    const client = new Client({name: 'test-client', version: '0.0.0'}, {capabilities: {}});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await run(client, workspace);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
}

function textOf(result: unknown): string {
  const content = (result as {content?: Array<{type: string; text?: string}>}).content ?? [];
  return content.find(item => item.type === 'text')?.text ?? '';
}

test('MCP server exposes the harness tool surface', async () => {
  await withClient(async client => {
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    for (const expected of [
      'get_brief',
      'get_view',
      'propose_hypothesis',
      'propose_experiment',
      'execute_experiment',
      'submit',
      'record_observation',
      'ask_human',
      'claim_gate',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });
});

test('get_brief and proposal tools work over MCP', async () => {
  await withClient(async client => {
    const brief = await client.callTool({name: 'get_brief', arguments: {}});
    const parsed = JSON.parse(textOf(brief)) as {task: {task_id: string}};
    assert.equal(parsed.task.task_id, 'test');

    const hypothesis = await client.callTool({
      name: 'propose_hypothesis',
      arguments: {claim: 'c', falsifier: 'f'},
    });
    const hypothesisPayload = JSON.parse(textOf(hypothesis)) as {id: string};
    assert.equal(hypothesisPayload.id, 'h-1');

    const invalid = await client.callTool({
      name: 'propose_experiment',
      arguments: {kind: 'discriminating', targets: ['h-1'], variable: 'x'},
    });
    assert.equal(invalid.isError, true);

    const observation = await client.callTool({
      name: 'record_observation',
      arguments: {summary: 'observed something', refs: []},
    });
    assert.equal((JSON.parse(textOf(observation)) as {strength: string}).strength, 'L0');
  });
});
