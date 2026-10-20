import {spawn} from 'node:child_process';

export interface ExecResult {
  status: 'completed' | 'failed' | 'timeout';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const started = Date.now();

  return new Promise(resolve => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        status: 'failed',
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        durationMs: Date.now() - started,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed',
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}
