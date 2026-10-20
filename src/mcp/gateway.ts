import fs from 'node:fs';
import path from 'node:path';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';

import {canonicalJson, sha256} from '../core/ledger.js';
import type {TaskStore} from '../core/task.js';

export interface GatewayConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface UpstreamClient {
  listTools(): Promise<{tools: UpstreamTool[]}>;
  callTool(params: {name: string; arguments?: Record<string, unknown>}): Promise<unknown>;
  close?(): Promise<void>;
}

export interface Upstream {
  client: UpstreamClient;
  tools: UpstreamTool[];
  close(): Promise<void>;
}

export function loadGatewayConfig(file: string): GatewayConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayConfig;
  if (!raw.command || typeof raw.command !== 'string') {
    throw new Error(`gateway config ${file} is missing a command`);
  }
  if (raw.args && (!Array.isArray(raw.args) || raw.args.some(arg => typeof arg !== 'string'))) {
    throw new Error(`gateway config ${file} has invalid args`);
  }
  return raw;
}

export async function connectUpstream(config: GatewayConfig): Promise<Upstream> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, config.env ?? {});

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env,
  });
  const client = new Client(
    {name: 'signal-jsreverse-harness-gateway', version: '0.1.0'},
    {capabilities: {}},
  );
  await client.connect(transport);
  const listed = await client.listTools();
  const upstream = client as unknown as UpstreamClient;
  return {
    client: upstream,
    tools: listed.tools as UpstreamTool[],
    close: async () => {
      await client.close();
    },
  };
}

export function registerGatewayTools(
  server: McpServer,
  store: TaskStore,
  upstream: Upstream,
): void {
  const json = (value: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}],
  });
  const fail = (message: string) => ({
    content: [{type: 'text' as const, text: JSON.stringify({error: message}, null, 2)}],
    isError: true,
  });

  server.registerTool(
    'gateway_list_tools',
    {
      description: 'List the upstream observation tools proxied by the gateway.',
      inputSchema: {},
      annotations: {readOnlyHint: true},
    },
    async () =>
      json({
        tools: upstream.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
        })),
      }),
  );

  server.registerTool(
    'gateway_call',
    {
      description:
        'Call an upstream observation tool through the gateway. Every call is recorded as L0 evidence.',
      inputSchema: {
        tool: z.string(),
        args: z.record(z.unknown()).default({}),
        experiment_id: z.string().optional(),
      },
    },
    async args => {
      const known = upstream.tools.find(tool => tool.name === args.tool);
      if (!known) return fail(`unknown upstream tool: ${args.tool}`);

      try {
        const result = await upstream.client.callTool({
          name: args.tool,
          arguments: args.args,
        });
        recordGatewayEvidence(store, {
          tool: args.tool,
          args: args.args,
          experimentId: args.experiment_id,
          result,
        });
        return result as CallToolResult;
      } catch (error) {
        const message = (error as Error).message;
        recordGatewayEvidence(store, {
          tool: args.tool,
          args: args.args,
          experimentId: args.experiment_id,
          result: null,
          error: message,
        });
        return fail(`gateway call failed: ${message}`);
      }
    },
  );
}

function recordGatewayEvidence(
  store: TaskStore,
  input: {
    tool: string;
    args: Record<string, unknown>;
    experimentId?: string;
    result: unknown;
    error?: string;
  },
): void {
  const id = `gw-${String(store.ledger.read().length + 1)}`;
  const dir = path.join(store.rootDir, 'gateway');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const artifact = path.join(dir, `${id}.json`);
  const record = {
    id,
    tool: input.tool,
    args: input.args,
    experiment_id: input.experimentId ?? null,
    result: input.result,
    error: input.error ?? null,
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(artifact, JSON.stringify(record, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  store.ledger.append(
    'agent',
    'evidence.recorded',
    {
      id,
      type: 'observation',
      strength: 'L0',
      source: 'gateway',
      tool: input.tool,
      args_digest: sha256(canonicalJson(input.args)),
      result_digest: sha256(canonicalJson(input.result)),
      experiment_id: input.experimentId ?? null,
      error: input.error ?? null,
      artifact,
    },
    [artifact, `tool:${input.tool}`],
  );
}
