import {gateStatus} from './gates.js';
import type {LedgerEvent} from './ledger.js';
import type {TaskStore} from './task.js';

export function renderTaskReport(store: TaskStore): string {
  const projection = store.projection();
  const events = store.ledger.read();
  const gates = gateStatus(store);
  const planned = new Map<string, Record<string, unknown>>();
  const completed = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.type === 'experiment.planned') {
      planned.set(String(event.payload['id']), event.payload);
    }
    if (event.type === 'experiment.completed') {
      completed.set(String(event.payload['id']), event.payload);
    }
  }

  const lines: string[] = [];
  lines.push(`# Task Report — ${projection.task.task_id}`);
  lines.push('');
  lines.push(`- Goal: ${projection.task.goal}`);
  lines.push(`- Profile: \`${projection.task.profile}\``);
  lines.push(`- Chain: \`${projection.task.chain}\``);
  lines.push(`- Created: ${projection.task.created_at}`);
  lines.push(`- Ledger: \`${store.rootDir}/ledger.jsonl\``);
  lines.push('');

  lines.push('## 1. Gate Status');
  lines.push('');
  lines.push(`- Current stage: \`${gates.current_stage ?? 'done'}\``);
  for (const stage of gates.stages) {
    lines.push(
      `- ${stage.id}: **${stage.status}**` +
        (stage.missing.length ? ` — missing: ${stage.missing.join(', ')}` : '') +
        (stage.needs_human.length ? ` — needs human: ${stage.needs_human.join(', ')}` : ''),
    );
  }
  lines.push('');

  lines.push('## 2. Hypotheses');
  lines.push('');
  if (projection.hypotheses.length === 0) lines.push('_No hypotheses recorded._');
  for (const hypothesis of projection.hypotheses) {
    lines.push(`- \`${hypothesis.id}\` [${hypothesis.status}] ${hypothesis.claim}`);
    lines.push(`  - Falsifier: ${hypothesis.falsifier}`);
    if (hypothesis.bound_experiment) {
      lines.push(`  - Bound experiment: \`${hypothesis.bound_experiment}\``);
    }
  }
  lines.push('');

  lines.push('## 3. Experiments');
  lines.push('');
  if (planned.size === 0) lines.push('_No experiments planned._');
  for (const [id, plan] of planned) {
    const completion = completed.get(id);
    const gain = completion?.['gain'];
    lines.push(
      `- \`${id}\` [${String(plan['kind'])}] targets=${JSON.stringify(plan['targets'] ?? [])}` +
        (plan['variable'] ? ` variable=${String(plan['variable'])}` : '') +
        (gain !== undefined ? ` gain=${String(gain)}` : ' — not settled'),
    );
  }
  lines.push('');

  lines.push('## 4. Divergence History');
  lines.push('');
  const divergenceEvents = events.filter(event => event.type === 'divergence.computed');
  if (divergenceEvents.length === 0) lines.push('_No divergence recorded._');
  for (const event of divergenceEvents) {
    const frontier = event.payload['frontier'] as Record<string, unknown> | null;
    lines.push(
      `- run \`${String(event.payload['run_id'])}\`: verdict=\`${String(event.payload['verdict'])}\`` +
        (frontier
          ? `, frontier=\`${String(frontier['symbol'])}\` (${String(frontier['classification'])})`
          : '') +
        `, meaningful=${String(event.payload['meaningful_count'] ?? 0)}`,
    );
  }
  lines.push('');

  lines.push('## 5. Oracle Results');
  lines.push('');
  if (projection.oracle_results.length === 0) lines.push('_No oracle submissions._');
  for (const result of projection.oracle_results) {
    lines.push(
      `- \`${String(result['run_id'])}\`: verdict=\`${String(result['verdict'])}\`, ` +
        `evidence=\`${String(result['evidence_level'])}\`, transport=\`${String(result['transport'])}\`` +
        (result['authorization_ref']
          ? `, authorization=\`${String(result['authorization_ref'])}\``
          : ''),
    );
  }
  lines.push('');

  lines.push('## 6. Negative Results');
  lines.push('');
  const negative = projection.hypotheses.filter(
    hypothesis => hypothesis.status === 'refuted' || hypothesis.status === 'withdrawn',
  );
  if (negative.length === 0) lines.push('_No refuted or withdrawn hypotheses._');
  for (const hypothesis of negative) {
    lines.push(`- \`${hypothesis.id}\` [${hypothesis.status}] ${hypothesis.claim}`);
  }
  lines.push('');

  lines.push('## 7. Unresolved Uncertainties');
  lines.push('');
  const open = projection.hypotheses.filter(
    hypothesis => hypothesis.status === 'proposed' || hypothesis.status === 'testing',
  );
  if (open.length === 0) lines.push('_No open hypotheses._');
  for (const hypothesis of open) lines.push(`- \`${hypothesis.id}\` ${hypothesis.claim}`);
  const currentGate = gates.stages.find(stage => stage.id === gates.current_stage);
  if (currentGate) {
    if (currentGate.missing.length) {
      lines.push(
        `- Gate \`${currentGate.id}\` missing evidence: ${currentGate.missing.join(', ')}`,
      );
    }
    if (currentGate.needs_human.length) {
      lines.push(`- Gate \`${currentGate.id}\` needs human: ${currentGate.needs_human.join(', ')}`);
    }
  }
  lines.push('');

  lines.push('## 8. Next Highest-Information Action');
  lines.push('');
  lines.push(nextAction(projection, gates, open));
  lines.push('');

  lines.push('## 9. Human Interventions');
  lines.push('');
  lines.push(`- Count: ${projection.human_interventions}`);
  const humanEvents = events.filter(event => event.type === 'human.decision');
  for (const event of humanEvents.slice(-10)) {
    lines.push(`- ${event.ts} — ${describeHumanEvent(event)}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function nextAction(
  projection: ReturnType<TaskStore['projection']>,
  gates: ReturnType<typeof gateStatus>,
  open: Array<{id: string; claim: string}>,
): string {
  if (projection.stop.triggered) {
    return `Stop is active (${projection.stop.reason ?? 'unknown'}). Review unresolved uncertainties or override as a human.`;
  }
  if (gates.current_stage !== null) {
    const stage = gates.stages.find(item => item.id === gates.current_stage);
    if (stage?.needs_human.length) {
      return `Obtain human attestation for gate \`${stage.id}\`: ${stage.needs_human.join(', ')}.`;
    }
    if (stage?.missing.length) {
      return `Collect evidence for gate \`${stage.id}\`: ${stage.missing.join(', ')}.`;
    }
  }
  if (open.length >= 2) {
    return `Design a discriminating experiment between \`${open[0].id}\` and \`${open[1].id}\`.`;
  }
  return 'Collect the next piece of evidence for the current gate.';
}

function describeHumanEvent(event: LedgerEvent): string {
  const kind = String(event.payload['kind'] ?? 'decision');
  if (kind === 'gate_attestation') {
    return `gate attestation for \`${String(event.payload['stage'])}\`: ${String(event.payload['statement'])}`;
  }
  if (kind === 'approval') {
    return `approval ${String(event.payload['approval_kind'])}: ${String(event.payload['authorization_ref'])}`;
  }
  if (kind === 'control_approval') {
    return `oracle control approval: ${String(event.payload['oracle_id'])}`;
  }
  if (kind === 'profile_change') {
    return `profile ${String(event.payload['from'])} → ${String(event.payload['to'])}`;
  }
  return kind;
}
