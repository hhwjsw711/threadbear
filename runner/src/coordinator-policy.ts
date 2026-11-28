// Shared coordinator and helper tool policy across every adapter (Claude,
// Codex, and ACP agents such as Antigravity/Gemini, Grok, OpenCode, Cursor).
// The coordinator reads and orchestrates; only its hidden runner-managed
// helpers implement changes. Enforced before Full access on every provider.
export const COORDINATOR_WORKER = 'coordinator-worker';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const CONTROL_TOOLS = new Set(['AskUserQuestion']);
export const CLAUDE_COORDINATOR_BUILTINS: readonly string[] = [...READ_TOOLS, ...CONTROL_TOOLS];
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'TaskOutput', 'TaskStop', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'run_workflow', 'send_message', 'subagent', 'task']);
const HELPER_BLOCKED_TOOLS = new Set(['Agent', 'Task', 'TaskOutput', 'TaskStop', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'run_workflow', 'send_message', 'subagent', 'task', 'AskUserQuestion', 'ask_question', 'EnterPlanMode', 'ExitPlanMode', 'request_user_input', 'request_user_input_async']);
const ACP_READ_KINDS = new Set(['read', 'search', 'fetch', 'think']);

export const PROJECT_READS = new Set(['list_projects', 'read_project', 'list_threads', 'read_thread', 'list_schedules', 'list_accounts']);
// add_button lets the coordinator offer an unrelated side job as a new
// thread that only Mike's press starts, so it can't escape its own boundary.
export const COORDINATOR_TOOLS = new Set(['update_project', 'send_message', 'end_turn', 'ask_secret', 'pin', 'unpin', 'show_options', 'show_panel', 'add_button', 'coordinator']);
export const COORDINATOR_THREADBEAR_TOOLS = new Set([...PROJECT_READS, ...COORDINATOR_TOOLS]);
export const HELPER_THREADBEAR_TOOLS = PROJECT_READS;

// Agent Archive's tools (agent-archive.ts), which only search and read past
// threads, so a coordinator can look back before asking the user something
// already settled. Exact names, not a prefix: a server called
// "agent-archive__x" must not ride on it. Claude names them
// mcp__agent-archive__<tool>; an ACP agent's request agent-archive__<tool>
// (AcpAgent.mcpToolName), which the ACP adapter also checks every frame of
// the call agrees on, and only where it gave the session the archive itself. Codex coordinators keep only this server (codex
// adapter, coordinatorMcpOff).
const ARCHIVE_READ_TOOLS = new Set(['get_archive_context', 'search_archive', 'list_recent_threads', 'list_user_messages', 'read_archive_thread', 'find_computer_history', 'read_computer_history_summary']);
export const ARCHIVE_READ_TOOL_NAMES: readonly string[] = [...ARCHIVE_READ_TOOLS];
export function archiveReadTool(serverAndTool: string): boolean {
  return serverAndTool.startsWith('agent-archive__') && ARCHIVE_READ_TOOLS.has(serverAndTool.slice('agent-archive__'.length));
}
export function readOnlyMcpTool(name: string): boolean {
  return name.startsWith('mcp__') && archiveReadTool(name.slice('mcp__'.length));
}

export const HELPER_REPORT = 'Report this question or blocked operation to the coordinator in your result and stop this job. The coordinator will answer from its instructions or ask the user, then resume you. Do not open a user card or try another way to get approval.';

export const COORDINATOR_WORKER_PROMPT = `You are an unattended helper for a Threadbear project coordinator. Nobody answers you directly.
Do the bounded job in the coordinator's brief and report the result to the coordinator. Use the repository's worktree workflow before editing; never edit its shared main checkout. Keep checkpoints and the paths, branch and verification needed to resume safely.
If information or permission is missing, report the question or blocked operation in your final result and stop. The coordinator handles it and may resume you with an answer. Never assume approval or repeat an uncertain side effect.
Do not call end_turn, ask_secret, user question tools, start another agent or create a Threadbear thread. Your final report goes to the coordinator. Do not ask the user to visit this helper.`;

// What a coordinator is told when it reaches for a shell or a Threadbear tool
// it doesn't have: what to use instead, so it doesn't retry the same call
// another way (26 Nov: `cat plan.md | head` and `tb schedules update` were
// refused with only "not available", five times in two coordinators).
const OTHER_THREADS = "To change another thread's schedule, snooze or work, ask that thread with send_message; your own next wake is coordinator action update with wakeAt.";
export const COORDINATOR_SHELL_REFUSAL = (reads: string): string =>
  `The project coordinator has no shell. Read and search files with ${reads}. ${OTHER_THREADS} Anything else that runs a command goes to a helper (coordinator action startHelper).`;
export const COORDINATOR_TB_REFUSAL = `This Threadbear tool is not available to a project coordinator; it has ${[...COORDINATOR_THREADBEAR_TOOLS].join(', ')}. ${OTHER_THREADS}`;

export function threadbearToolName(name: string): string | undefined {
  if (name.startsWith('mcp__threadbear__')) return name.slice('mcp__threadbear__'.length);
  if (name.startsWith('threadbear__')) return name.slice('threadbear__'.length);
  return undefined;
}

export function isHelperQuestionTool(name: string): boolean {
  return name === 'AskUserQuestion' || name === 'ask_question' || /(?:^|__)request_user_input(?:_async)?$/.test(name);
}

// Claude PreToolUse policy for coordinator and helper sessions.
export function coordinatorTool(name: string, _input: Record<string, unknown>, helper: boolean): { reason?: string; updatedInput?: Record<string, unknown> } {
  const tb = threadbearToolName(name);
  if (helper) {
    if (HELPER_BLOCKED_TOOLS.has(name) || isHelperQuestionTool(name) || (tb !== undefined && !HELPER_THREADBEAR_TOOLS.has(tb))) return { reason: HELPER_REPORT };
    return {};
  }
  if (name === 'Agent' || name === 'Task' || name === 'TaskOutput' || name === 'TaskStop') {
    return { reason: 'Delegate implementation to a helper with the coordinator tool (startHelper or resumeHelper), not native sub-agents.' };
  }
  if (READ_TOOLS.has(name) || CONTROL_TOOLS.has(name) || readOnlyMcpTool(name) || (tb !== undefined && COORDINATOR_THREADBEAR_TOOLS.has(tb))) return {};
  if (tb !== undefined) return { reason: COORDINATOR_TB_REFUSAL };
  if (name === 'Bash') return { reason: COORDINATOR_SHELL_REFUSAL('Read, Grep and Glob (Grep takes a pattern, a path and -n/-A/-B, so no cat, head or grep is needed)') };
  return { reason: 'The project coordinator can read and orchestrate. Delegate implementation to a helper with the coordinator tool (startHelper); this tool is not available to the coordinator.' };
}

// ACP permission policy for coordinator and helper sessions.
// readOnlyMcp: the ACP adapter found the call is one of Agent Archive's read
// tools, every frame agreeing (archiveReadTool).
export function acpCoordinatorTool(p: { role: 'coordinator' | 'helper'; kind?: string; name?: string; mcpName?: string; external?: boolean; readOnlyMcp?: boolean }): { reason?: string } {
  const tb = p.mcpName ? threadbearToolName(p.mcpName) : undefined;
  if (p.role === 'helper') {
    if (tb !== undefined) return HELPER_THREADBEAR_TOOLS.has(tb) ? {} : { reason: HELPER_REPORT };
    if (p.name && (HELPER_BLOCKED_TOOLS.has(p.name) || isHelperQuestionTool(p.name))) return { reason: HELPER_REPORT };
    return {};
  }
  if (tb !== undefined) {
    return COORDINATOR_THREADBEAR_TOOLS.has(tb) ? {} : { reason: COORDINATOR_TB_REFUSAL };
  }
  if (p.readOnlyMcp) return {};
  if (p.external) {
    return { reason: 'The project coordinator can read and orchestrate. Delegate external tool calls to a helper with the coordinator tool (startHelper).' };
  }
  if (p.name && SUBAGENT_TOOLS.has(p.name)) {
    return { reason: 'Delegate implementation to a helper with the coordinator tool (startHelper or resumeHelper), not native sub-agents.' };
  }
  if (p.kind && ACP_READ_KINDS.has(p.kind)) return {};
  if ((p.kind === undefined || p.kind === 'other') && (p.name === 'AskUserQuestion' || p.name === 'ask_question')) return {};
  if (p.kind === 'execute') return { reason: COORDINATOR_SHELL_REFUSAL('your read and search tools') };
  return { reason: 'The project coordinator can read and orchestrate. Delegate implementation to a helper with the coordinator tool (startHelper); this tool is not available to the coordinator.' };
}
