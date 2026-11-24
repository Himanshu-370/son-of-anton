// The decision helpers moved to the shared job actions; re-exported for the remaining CLI callers.
export { preflightOr2, refuseIfRunning, switchBackFromJob } from '../../core/job-actions.js';
