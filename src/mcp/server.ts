import fs from 'node:fs';
import path from 'node:path';

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

import {assertSubmissionBudget} from '../core/budget.js';
import {commandRunSpecFromConfig, runManagedCommand} from '../core/command-runner.js';
import {ExperimentBook} from '../core/experiments.js';
import {claimGate, gateStatus, type StageId} from '../core/gates.js';
import {submitHttp} from '../core/http-submitter.js';
import {Ledger} from '../core/ledger.js';
import {loadOracleBundle} from '../core/oracle-loader.js';
import {SubmitService} from '../core/submit.js';
import {TaskStore, taskDir} from '../core/task.js';
import {
  connectUpstream,
  registerGatewayTools,
  type GatewayConfig,
  type Upstream,
} from './gateway.js';

export interface HarnessServerOptions {
  workspaceRoot: string;
  taskId: string;
  allowLive?: boolean;
  gateway?: GatewayConfig;
}

export interface HarnessServerBundle {
  server: McpServer;
  store: TaskStore;
}

export function createHarnessServer(options: HarnessServerOptions): McpServer {
  return createHarnessServerBundle(options).server;
}

export function createHarnessServerBundle(options: HarnessServerOptions): HarnessServerBundle {
  const store = TaskStore.open(taskDir(options.workspaceRoot, options.taskId));
  const server = new McpServer(
    {name: 'signal-jsreverse-harness', version: '0.1.0'},
    {capabilities: {logging: {}}},
  );

  const json = (value: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}],
  });
  const fail = (message: string) => ({
    content: [{type: 'text' as const, text: JSON.stringify({error: message}, null, 2)}],
    isError: true,
  });

  server.registerTool(
    'get_brief',
    {
      description: 'Return the task projection and current constraints for the next episode.',
      inputSchema: {},
      annotations: {readOnlyHint: true},
    },
    async () => {
      const projection = store.projection();
      return json({
        task: projection.task,
        gate: gateStatus(store),
        stop: projection.stop,
        open_hypotheses: projection.hypotheses.filter(
          h => h.status === 'proposed' || h.status === 'testing',
        ),
        last_frontier: projection.frontier,
        recent_runs: projection.runs.slice(-3),
        recent_oracle_results: projection.oracle_results.slice(-3),
        constraints: {
          live_submission: options.allowLive === true,
          write_submission_requires_authorization: true,
          profile: projection.task.profile,
          chain: projection.task.chain,
        },
      });
    },
  );

  server.registerTool(
    'get_view',
    {
      description:
        'Read a projection slice: hypotheses, experiments, runs, oracle, evidence, or stop.',
      inputSchema: {
        name: z.enum(['hypotheses', 'experiments', 'runs', 'oracle', 'evidence', 'stop']),
      },
      annotations: {readOnlyHint: true},
    },
    async args => {
      const projection = store.projection();
      switch (args.name) {
        case 'hypotheses':
          return json(projection.hypotheses);
        case 'experiments':
          return json(projection.experiments);
        case 'runs':
          return json(projection.runs);
        case 'oracle':
          return json(projection.oracle_results);
        case 'evidence':
          return json(projection.evidence);
        case 'stop':
          return json(projection.stop);
      }
    },
  );

  server.registerTool(
    'propose_hypothesis',
    {
      description: 'Propose a falsifiable hypothesis. Proposals do not count as information gain.',
      inputSchema: {
        claim: z.string().describe('Falsifiable claim about target behavior'),
        falsifier: z.string().describe('Observation that would refute the claim'),
        bound_experiment: z
          .string()
          .optional()
          .describe('Existing discriminating experiment id used to defer stop'),
      },
    },
    async args => {
      const book = new ExperimentBook(store.ledger);
      return json(
        book.proposeHypothesis({
          claim: args.claim,
          falsifier: args.falsifier,
          boundExperiment: args.bound_experiment,
        }),
      );
    },
  );

  server.registerTool(
    'propose_experiment',
    {
      description:
        'Plan a single-variable experiment. This records the plan only; use execute_experiment to run it.',
      inputSchema: {
        kind: z.enum(['probe', 'discriminating', 'verification']),
        targets: z.array(z.string()),
        variable: z.string().optional(),
        adapter: z.enum(['command']).default('command'),
        command: z.string().describe('command to execute for this experiment'),
        args: z.array(z.string()).default([]),
        cwd: z.string().optional(),
        env: z.record(z.string()).optional(),
        timeout_ms: z.number().optional(),
        output_path: z.string().optional(),
        trace_path: z.string().optional(),
        reference_trace_path: z.string().optional(),
        volatile_symbols: z.array(z.string()).optional(),
      },
    },
    async args => {
      const book = new ExperimentBook(store.ledger);
      if (args.kind === 'discriminating' && args.targets.length < 2) {
        return fail('discriminating experiment requires at least two target hypotheses');
      }
      const experiment = book.planExperiment({
        kind: args.kind,
        targets: args.targets,
        variable: args.variable,
        adapter: args.adapter,
        config: {
          command: args.command,
          args: args.args,
          cwd: args.cwd,
          env: args.env,
          timeout_ms: args.timeout_ms,
          output_path: args.output_path,
          trace_path: args.trace_path,
          reference_trace_path: args.reference_trace_path,
          volatile_symbols: args.volatile_symbols,
        },
      });
      return json(experiment);
    },
  );

  server.registerTool(
    'execute_experiment',
    {
      description:
        'Execute a planned experiment through the managed run executor and record divergence.',
      inputSchema: {
        id: z.string(),
        gain: z.union([z.literal(0), z.literal(1)]).optional(),
      },
    },
    async args => {
      const plan = findExperimentPlan(store.ledger, args.id);
      if (!plan) return fail(`unknown experiment: ${args.id}`);
      const book = new ExperimentBook(store.ledger);
      if (!book.canRunExperiment()) {
        return fail('stop already triggered; append stop.overridden before new experiments');
      }

      const config = plan['config'] as Record<string, unknown> | undefined;
      if (!config) return fail('experiment has no command config');
      const result = await runManagedCommand(store, commandRunSpecFromConfig(config));
      const divergence = result.divergence;

      const gain = args.gain ?? 0;
      if (gain === 1 && divergence?.verdict === 'no_divergence') {
        return fail('gain=1 cannot be justified when divergence verdict is no_divergence');
      }
      const state = book.completeExperiment({id: args.id, gain: gain as 0 | 1});
      return json({
        experiment: args.id,
        run: result.run.id,
        exec: {
          status: result.exec.status,
          exit_code: result.exec.exitCode,
          duration_ms: result.exec.durationMs,
        },
        divergence,
        gain,
        stop: state,
        artifacts: result.artifactsDir,
      });
    },
  );

  server.registerTool(
    'submit',
    {
      description:
        'Submit a managed run output to an oracle. Requires --allow-live; write endpoints also require authorization_ref.',
      inputSchema: {
        run_id: z.string(),
        oracle_id: z.string(),
        authorization_ref: z.string().optional(),
        headers: z.record(z.string()).optional(),
      },
    },
    async args => {
      if (!options.allowLive) {
        return fail('live submission is disabled; start the harness with --allow-live');
      }
      const run = store.projection().runs.find(item => item['id'] === args.run_id);
      if (!run) return fail(`unknown run: ${args.run_id}`);
      const generatedPath = (run['artifacts'] as Record<string, unknown> | undefined)?.[
        'generated'
      ];
      if (typeof generatedPath !== 'string') return fail('run has no generated request artifact');
      const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8')) as {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      };
      assertSubmissionBudget(store);
      const bundle = loadOracle(store, args.oracle_id);
      const http = await submitHttp({
        oracle: bundle.oracle,
        request: {
          url: generated.url,
          method: generated.method ?? 'POST',
          headers: {...(generated.headers ?? {}), ...(args.headers ?? {})},
          body: generated.body,
        },
        allowLive: true,
        authorizationRef: args.authorization_ref,
        artifactDir: path.join(path.dirname(generatedPath), `submission-${Date.now()}`),
      });
      const submitService = new SubmitService(store.ledger, store.taskId);
      const record = submitService.submitLive({
        oracle: bundle.oracle,
        calibration: bundle.calibration,
        http,
        runId: args.run_id,
        authorizationRef: args.authorization_ref,
      });
      return json({submission: record, http});
    },
  );

  server.registerTool(
    'record_observation',
    {
      description: 'Append an L0 observation. It cannot support an L2 conclusion.',
      inputSchema: {
        summary: z.string(),
        refs: z.array(z.string()).default([]),
      },
    },
    async args => {
      const evidence = {
        id: `ev-${store.ledger.read().length + 1}`,
        type: 'observation',
        strength: 'L0',
        refs: args.refs,
        interpretation: args.summary,
        actor: 'agent',
      };
      store.ledger.append('agent', 'evidence.recorded', evidence, args.refs);
      return json(evidence);
    },
  );

  server.registerTool(
    'ask_human',
    {
      description:
        'Record a human decision request (positive-control approval, write authorization, override, or adjudication).',
      inputSchema: {
        kind: z.enum(['control', 'write', 'override', 'adjudication']),
        payload: z.record(z.unknown()).optional(),
      },
    },
    async args => {
      const request = {
        kind: args.kind,
        payload: args.payload ?? {},
        status: 'requested',
        requested_at: new Date().toISOString(),
      };
      store.ledger.append('agent', 'human.decision', request);
      return json({
        request,
        note: 'A human must approve this request via the CLI before it takes effect.',
      });
    },
  );

  server.registerTool(
    'claim_gate',
    {
      description:
        'Claim the current stage gate. The harness evaluates deterministic requirements and reports missing human attestations.',
      inputSchema: {
        stage: z.enum(['frame', 'observe', 'isolate', 'hypothesize', 'rebuild', 'validate']),
        evidence: z.array(z.string()).default([]),
      },
    },
    async args => {
      try {
        return json(claimGate(store, args.stage as StageId, args.evidence));
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  return {server, store};
}

export async function serveStdio(options: HarnessServerOptions): Promise<void> {
  const {server, store} = createHarnessServerBundle(options);
  let upstream: Upstream | undefined;
  if (options.gateway) {
    upstream = await connectUpstream(options.gateway);
    registerGatewayTools(server, store, upstream);
  }
  if (upstream) {
    const shutdown = () => {
      void upstream
        ?.close()
        .catch(() => {})
        .finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function findExperimentPlan(ledger: Ledger, id: string): Record<string, unknown> | null {
  const events = ledger.read().filter(event => event.type === 'experiment.planned');
  const found = [...events].reverse().find(event => event.payload['id'] === id);
  return found?.payload ?? null;
}

function loadOracle(store: TaskStore, oracleId: string) {
  return loadOracleBundle(store.rootDir, oracleId);
}
