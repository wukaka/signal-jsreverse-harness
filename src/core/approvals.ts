import type {LedgerEvent} from './ledger.js';
import type {TaskStore} from './task.js';

export type ApprovalKind = 'control' | 'write' | 'override' | 'budget';

export function recordApproval(
  store: TaskStore,
  input: {kind: ApprovalKind; ref: string; note: string; scope?: Record<string, unknown>},
): LedgerEvent {
  if (!input.ref.trim()) throw new Error('approval requires a reference');
  if (!input.note.trim()) throw new Error('approval requires a note');
  return store.ledger.append('human', 'human.decision', {
    kind: 'approval',
    approval_kind: input.kind,
    authorization_ref: input.ref,
    note: input.note,
    scope: input.scope ?? {},
  });
}
