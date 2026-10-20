import type {TaskStore} from './task.js';

export function assertSubmissionBudget(store: TaskStore): void {
  const budget = store.config.budget;
  const projection = store.projection();
  const liveSubmissions = projection.oracle_results.filter(
    result => result['transport'] === 'live',
  ).length;
  if (budget.submissions > 0 && liveSubmissions >= budget.submissions) {
    throw new Error(
      `submission budget exhausted: ${liveSubmissions}/${budget.submissions} live submissions used`,
    );
  }
  const elapsedMinutes = (Date.now() - Date.parse(store.config.created_at)) / 60_000;
  if (budget.wall_time_min > 0 && elapsedMinutes > budget.wall_time_min) {
    throw new Error(
      `wall-time budget exhausted: ${elapsedMinutes.toFixed(1)}/${budget.wall_time_min} minutes`,
    );
  }
}
