// Re-exported from the shared coordinator policy so Claude adapter imports
// stay stable while Codex and ACP share the exact same boundary rules.
export {
  CLAUDE_COORDINATOR_BUILTINS,
  COORDINATOR_WORKER,
  COORDINATOR_WORKER_PROMPT,
  HELPER_REPORT,
  coordinatorTool,
  isHelperQuestionTool,
} from '../../coordinator-policy.ts';
