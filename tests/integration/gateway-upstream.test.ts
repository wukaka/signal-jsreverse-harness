import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {connectUpstream} from '../../src/mcp/gateway.js';

test('gateway connects to a real stdio MCP upstream', {timeout: 20_000}, async () => {
  const upstream = await connectUpstream({
    command: process.execPath,
    args: [path.join(process.cwd(), 'build/tests/fixtures/upstream-mcp.js')],
  });
  try {
    assert.deepEqual(
      upstream.tools.map(tool => tool.name),
      ['echo'],
    );
    const result = (await upstream.client.callTool({
      name: 'echo',
      arguments: {text: 'hello-gateway'},
    })) as {content?: Array<{type: string; text?: string}>};
    assert.equal(result.content?.[0]?.text, 'hello-gateway');
  } finally {
    await upstream.close();
  }
});
