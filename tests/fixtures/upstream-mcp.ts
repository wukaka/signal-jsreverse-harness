import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const server = new McpServer({name: 'fixture-upstream', version: '0.0.1'}, {capabilities: {}});

server.registerTool(
  'echo',
  {
    description: 'Echo text back',
    inputSchema: {text: z.string()},
    annotations: {readOnlyHint: true},
  },
  async args => ({
    content: [{type: 'text' as const, text: args.text}],
  }),
);

await server.connect(new StdioServerTransport());
