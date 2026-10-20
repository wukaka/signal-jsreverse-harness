import fs from 'node:fs';
import path from 'node:path';

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {recordApproval, type ApprovalKind} from './core/approvals.js';
import {commandRunSpecFromConfig, runManagedCommand} from './core/command-runner.js';
import {ExperimentBook} from './core/experiments.js';
import {saveOracle} from './core/oracle-store.js';
import {renderTaskReport} from './core/report.js';
import type {OracleConfig, VerdictClass} from './core/oracle.js';
import {attestGate, claimGate, gateStatus, type FailureLayer, type StageId} from './core/gates.js';
import {Ledger} from './core/ledger.js';
import {parseHeaderOverrides, submitLatestRun} from './core/live-submit.js';
import {loadOracleBundle} from './core/oracle-loader.js';
import {loadProfile, validateProfile, type ProfileDefinition} from './core/profiles.js';
import {TaskStore, taskDir} from './core/task.js';
import {loadGatewayConfig} from './mcp/gateway.js';
import {serveStdio} from './mcp/server.js';

void yargs(hideBin(process.argv))
  .scriptName('harness')
  .command(
    'init',
    'Initialize a task workspace under .harness/tasks/<task>',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('goal', {type: 'string', default: 'JS reverse task'})
        .option('profile', {type: 'string', default: 'full'})
        .option('profileFile', {
          type: 'string',
          describe: 'custom profile JSON copied into the task',
        })
        .option('chain', {
          type: 'string',
          choices: ['browser', 'offline', 'hybrid'] as const,
          default: 'offline',
        })
        .option('oracle', {type: 'array', string: true, default: []}),
    argv => {
      const root = taskDir(process.cwd(), argv.task);
      let profile = argv.profile;
      let profileJson: ProfileDefinition | undefined;
      if (argv.profileFile) {
        const source = path.resolve(process.cwd(), argv.profileFile);
        profileJson = validateProfile(JSON.parse(fs.readFileSync(source, 'utf8')), source);
        profile = profileJson.name;
      } else {
        loadProfile(profile, [
          root,
          path.resolve(root, '..', '..'),
          path.join(process.cwd(), 'profiles'),
        ]);
      }
      const store = TaskStore.init(root, {
        task_id: argv.task,
        goal: argv.goal,
        profile,
        chain: argv.chain as 'browser' | 'offline' | 'hybrid',
        oracle_refs: argv.oracle,
        budget: {submissions: 0, wall_time_min: 120},
      });
      if (profileJson) {
        const dir = path.join(store.rootDir, 'profiles');
        fs.mkdirSync(dir, {recursive: true, mode: 0o700});
        fs.writeFileSync(
          path.join(dir, `${profileJson.name}.json`),
          JSON.stringify(profileJson, null, 2),
          'utf8',
        );
      }
      console.log(`task initialized: ${store.rootDir}`);
      console.log(`profile=${store.config.profile} chain=${store.config.chain}`);
    },
  )
  .command(
    'hypothesis add',
    'Propose a falsifiable hypothesis',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('claim', {type: 'string', demandOption: true})
        .option('falsifier', {type: 'string', demandOption: true})
        .option('bound', {type: 'string', describe: 'bound discriminating experiment id'}),
    argv => {
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      const book = new ExperimentBook(store.ledger);
      console.log(
        JSON.stringify(
          book.proposeHypothesis({
            claim: argv.claim,
            falsifier: argv.falsifier,
            boundExperiment: argv.bound,
          }),
          null,
          2,
        ),
      );
    },
  )
  .command(
    'experiment <sub>',
    'Plan or complete a single-variable experiment',
    yargsInstance =>
      yargsInstance
        .positional('sub', {
          type: 'string',
          choices: ['plan', 'execute', 'complete'] as const,
        })
        .option('task', {type: 'string', default: 'default'})
        .option('kind', {
          type: 'string',
          choices: ['probe', 'discriminating', 'verification'] as const,
        })
        .option('targets', {type: 'array', string: true, default: []})
        .option('variable', {type: 'string'})
        .option('command', {type: 'string', describe: 'command to execute'})
        .option('args', {type: 'array', string: true, default: []})
        .option('cwd', {type: 'string'})
        .option('env', {type: 'array', string: true, default: []})
        .option('outputPath', {type: 'string', describe: 'file whose contents are the run output'})
        .option('tracePath', {type: 'string', describe: 'JSONL semantic event trace from the run'})
        .option('referenceTracePath', {
          type: 'string',
          describe: 'JSONL reference trace for divergence',
        })
        .option('volatile', {type: 'array', string: true, default: []})
        .option('id', {type: 'string'})
        .option('gain', {type: 'number', choices: [0, 1] as const}),
    async argv => {
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      const book = new ExperimentBook(store.ledger);
      if (argv.sub === 'plan') {
        if (!argv.kind) throw new Error('--kind is required for experiment plan');
        if (argv.kind === 'discriminating' && argv.targets.length < 2) {
          throw new Error('discriminating experiment requires at least two targets');
        }
        if (!argv.command) throw new Error('--command is required for experiment plan');
        const env: Record<string, string> = {};
        for (const entry of argv.env) {
          const index = entry.indexOf('=');
          if (index <= 0) throw new Error(`invalid --env value: ${entry}`);
          env[entry.slice(0, index)] = entry.slice(index + 1);
        }
        console.log(
          JSON.stringify(
            book.planExperiment({
              kind: argv.kind,
              targets: argv.targets,
              variable: argv.variable,
              adapter: 'command',
              config: {
                command: argv.command,
                args: argv.args,
                cwd: argv.cwd,
                env,
                output_path: argv.outputPath,
                trace_path: argv.tracePath,
                reference_trace_path: argv.referenceTracePath,
                volatile_symbols: argv.volatile,
              },
            }),
            null,
            2,
          ),
        );
        return;
      }
      if (argv.sub === 'execute') {
        if (!argv.id) throw new Error('--id is required for experiment execute');
        if (argv.gain === undefined) throw new Error('--gain is required for experiment execute');
        const plan = [...store.ledger.read()]
          .reverse()
          .find(
            event => event.type === 'experiment.planned' && event.payload['id'] === argv.id,
          )?.payload;
        if (!plan) throw new Error(`unknown experiment: ${argv.id}`);
        const config = plan['config'] as Record<string, unknown> | undefined;
        if (!config) throw new Error('experiment has no command config');
        const result = await runManagedCommand(store, commandRunSpecFromConfig(config));
        const state = book.completeExperiment({id: argv.id, gain: argv.gain as 0 | 1});
        console.log(
          JSON.stringify(
            {
              run: result.run.id,
              exec: {
                status: result.exec.status,
                exit_code: result.exec.exitCode,
                duration_ms: result.exec.durationMs,
              },
              divergence: result.divergence,
              gain: argv.gain,
              stop: state,
              artifacts: result.artifactsDir,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (!argv.id) throw new Error('--id is required for experiment complete');
      if (argv.gain === undefined) throw new Error('--gain is required for experiment complete');
      console.log(
        JSON.stringify(book.completeExperiment({id: argv.id, gain: argv.gain as 0 | 1}), null, 2),
      );
    },
  )
  .command(
    'stop override',
    'Record a human override and reset the stop state',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('reason', {type: 'string', demandOption: true}),
    argv => {
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      const book = new ExperimentBook(store.ledger);
      console.log(JSON.stringify(book.override(argv.reason), null, 2));
    },
  )
  .command(
    'profile set',
    'Switch the task profile (human decision)',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('profile', {type: 'string', demandOption: true})
        .option('reason', {type: 'string', default: ''}),
    argv => {
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      loadProfile(argv.profile, [
        store.rootDir,
        path.resolve(store.rootDir, '..', '..'),
        path.join(process.cwd(), 'profiles'),
      ]);
      const from = store.config.profile;
      store.config.profile = argv.profile;
      fs.writeFileSync(
        path.join(store.rootDir, 'task.json'),
        JSON.stringify(store.config, null, 2),
        'utf8',
      );
      store.ledger.append('human', 'human.decision', {
        kind: 'profile_change',
        from,
        to: argv.profile,
        reason: argv.reason,
      });
      console.log(JSON.stringify({from, to: argv.profile}, null, 2));
    },
  )
  .command(
    'approve',
    'Record a human approval (control, write, override, budget)',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('kind', {
          type: 'string',
          choices: ['control', 'write', 'override', 'budget'] as const,
          demandOption: true,
        })
        .option('ref', {type: 'string', demandOption: true})
        .option('note', {type: 'string', demandOption: true})
        .option('scope', {type: 'string', describe: 'optional JSON scope'}),
    argv => {
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      const scope = argv.scope ? (JSON.parse(argv.scope) as Record<string, unknown>) : undefined;
      console.log(
        JSON.stringify(
          recordApproval(store, {
            kind: argv.kind as ApprovalKind,
            ref: argv.ref,
            note: argv.note,
            scope,
          }),
          null,
          2,
        ),
      );
    },
  )
  .command(
    'oracle save',
    'Save an oracle config and optionally approve its controls',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('file', {type: 'string', demandOption: true})
        .option('approve', {type: 'boolean', default: false})
        .option('positive', {type: 'array', string: true, default: ['accept']})
        .option('negative', {type: 'array', string: true, default: ['reject']}),
    argv => {
      const oracle = JSON.parse(fs.readFileSync(path.resolve(argv.file), 'utf8')) as OracleConfig;
      if (!oracle.id || !oracle.kind || !oracle.scope || !oracle.verdict || !oracle.calibration) {
        throw new Error('invalid oracle config');
      }
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      const result = saveOracle(store, {
        oracle,
        observed: {
          positive: argv.positive as VerdictClass[],
          negative: argv.negative as VerdictClass[],
        },
        approve: argv.approve,
      });
      console.log(
        JSON.stringify(
          {
            path: result.path,
            status: result.calibration.status,
            canL2: result.calibration.canL2,
            errors: result.calibration.errors,
          },
          null,
          2,
        ),
      );
    },
  )
  .command(
    'task-report',
    'Render a task report from the ledger',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('out', {type: 'string'}),
    argv => {
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      const markdown = renderTaskReport(store);
      const out = path.resolve(process.cwd(), argv.out ?? path.join(store.rootDir, 'report.md'));
      fs.mkdirSync(path.dirname(out), {recursive: true});
      fs.writeFileSync(out, markdown, 'utf8');
      console.log(out);
    },
  )
  .command(
    'gate <sub>',
    'Inspect, claim, or attest stage gates',
    yargsInstance =>
      yargsInstance
        .positional('sub', {type: 'string', choices: ['status', 'claim', 'attest'] as const})
        .option('task', {type: 'string', default: 'default'})
        .option('stage', {type: 'string'})
        .option('evidence', {type: 'array', string: true, default: []})
        .option('statement', {type: 'string'})
        .option('layer', {
          type: 'string',
          choices: ['transport', 'client_context', 'content', 'time', 'session_state'] as const,
        }),
    argv => {
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      if (argv.sub === 'status') {
        console.log(JSON.stringify(gateStatus(store), null, 2));
        return;
      }
      if (!argv.stage) throw new Error('--stage is required');
      if (argv.sub === 'claim') {
        console.log(
          JSON.stringify(claimGate(store, argv.stage as StageId, argv.evidence), null, 2),
        );
        return;
      }
      if (!argv.statement) throw new Error('--statement is required for attest');
      attestGate(store, {
        stage: argv.stage as StageId,
        requirement: 'failure_layer',
        statement: argv.statement,
        failureLayer: argv.layer as FailureLayer | undefined,
      });
      console.log(JSON.stringify(gateStatus(store), null, 2));
    },
  )
  .command(
    'serve',
    'Start the harness MCP server over stdio',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('allow-live', {
          type: 'boolean',
          default: false,
          describe: 'enable live oracle submissions (write endpoints still require authorization)',
        })
        .option('gatewayConfig', {
          type: 'string',
          describe: 'JSON file with {command, args, env} for the upstream observation MCP',
        }),
    async argv => {
      await serveStdio({
        workspaceRoot: process.cwd(),
        taskId: argv.task,
        allowLive: argv.allowLive,
        gateway: argv.gatewayConfig
          ? loadGatewayConfig(path.resolve(process.cwd(), argv.gatewayConfig))
          : undefined,
      });
    },
  )
  .command(
    'status',
    'Print the ledger projection for a task',
    yargsInstance => yargsInstance.option('task', {type: 'string', default: 'default'}),
    argv => {
      const store = TaskStore.open(taskDir(process.cwd(), argv.task));
      console.log(JSON.stringify(store.projection(), null, 2));
    },
  )
  .command(
    'ledger verify',
    'Verify the append-only ledger hash chain',
    yargsInstance => yargsInstance.option('task', {type: 'string', default: 'default'}),
    argv => {
      const ledger = Ledger.open(
        path.join(taskDir(process.cwd(), argv.task), 'ledger.jsonl'),
        argv.task,
      );
      const result = ledger.verify();
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    },
  )
  .command(
    'submit',
    'Submit the latest managed run to the oracle (requires --live and a human authorization ref)',
    yargsInstance =>
      yargsInstance
        .option('task', {type: 'string', default: 'default'})
        .option('oracle', {type: 'string', demandOption: true})
        .option('run', {type: 'string'})
        .option('authorize', {type: 'string', describe: 'human authorization reference'})
        .option('live', {type: 'boolean', default: false})
        .option('headers', {type: 'array', string: true, default: []}),
    async argv => {
      if (!argv.live || !argv.authorize) {
        console.error('refusing live submission: pass --live --authorize <human-approval-ref>');
        process.exitCode = 1;
        return;
      }
      try {
        const store = TaskStore.open(taskDir(process.cwd(), argv.task));
        const bundle = loadOracleBundle(store.rootDir, argv.oracle);
        const headers = parseHeaderOverrides(argv.headers);
        const result = await submitLatestRun({
          store,
          bundle,
          authorizationRef: argv.authorize,
          allowLive: true,
          runId: argv.run,
          headers,
        });
        console.log(
          JSON.stringify(
            {
              run: result.run['id'],
              verdict: result.submission.verdict,
              evidence_level: result.submission.evidence_level,
              http_status: result.http.http_status,
              response: result.http.json ?? result.http.text,
              authorization_ref: result.submission.authorization_ref,
            },
            null,
            2,
          ),
        );
        console.log(JSON.stringify(gateStatus(store), null, 2));
        if (result.submission.evidence_level !== 'L2') process.exitCode = 1;
      } catch (error) {
        console.error(`submit failed: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    },
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();
