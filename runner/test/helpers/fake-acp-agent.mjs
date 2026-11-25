#!/usr/bin/env node
// A pretend ACP agent for tests, which follows what OpenCode 1.18.23 was seen
// to do on 9 Nov 2026: by default it runs tools without asking; config in
// OPENCODE_CONFIG_CONTENT makes it ask, a folder's opencode.json outranks that
// unless OPENCODE_DISABLE_PROJECT_CONFIG is set, and a folder's plugin runs
// when a session opens. A prompt's words say what it does:
//   "write <path> <text>"  a write through its tool (asks or not, as above)
//   "exec <command>"       the same for a shell command
//   "hello"                just answers
// FAKE_ACP_LOG: where each request is appended, as JSON lines.
//
// FAKE_ACP_NAME=Grok follows Grok 1.0.77 (15 Nov 2026) instead: it runs every
// tool unasked (as its auto mode did) unless a PreToolUse hook from the plugin
// named by --plugin-dir says ask or deny, and runs that hook as Grok would,
// so the real guard script is what decides. More words for it:
//   "read <path>"          its read_file tool
//   "mcp <server__tool>"   an MCP tool, through its use_tool
//   "broke"                a login out of balance, as Grok 1.0.92 answered on
//                          23 Nov 2026: no model call, a failed retry_state and
//                          turn_completed, and "Internal error" with the real
//                          reason in data (GROK_OUT_OF_BALANCE below)
// and it answers _x.ai/billing with FAKE_GROK_BILLING (JSON), else a plan
// with 40% of its week used.
//
// FAKE_ACP_NAME=Antigravity follows Google's antigravity-acp 1.4.5 (20 Nov
// 2026): it writes skills/system/run-workflow/SKILL.md into the session's cwd
// as a session opens, asks before every tool in its default mode, and its
// shell tool's arguments are CommandLine and Cwd. "exec <command>" runs in
// the first additional directory (where it was told the work is), "read
// <path>" is its view_file. Its session/new says the plan's tier, it lists
// its slash commands just after, and "/usage" is answered by the server with
// FAKE_ACP_USAGE (or 1.4.5's answer of 23 Nov 2026), with no model turn.
// FAKE_ACP_NO_USAGE_COMMAND leaves it out of the list, and "/usage" then goes
// to the model as any prompt would.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const env = process.env;
const logFile = env.FAKE_ACP_LOG;
const log = (m) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(m)}\n`);
};
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const AGENT = env.FAKE_ACP_NAME ?? 'OpenCode';
let nextOwn = 0; // from 0, as OpenCode's are
const waiting = new Map();
const pausedPrompts = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextOwn++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const GROK = AGENT === 'Grok';
const AGY = AGENT === 'Antigravity';
const OPENCODE_EFFORTS = !GROK && !AGY && Boolean(env.FAKE_ACP_OPENCODE_EFFORTS);
const sessions = new Map();
let mode = AGENT === 'Antigravity' ? 'default' : 'build';
let model = GROK ? 'grok-4.7' : AGENT === 'Antigravity' ? 'gemini-3.8-flash' : 'fake/one';
let effort = OPENCODE_EFFORTS ? 'default' : 'high';
const agyThinkingOptions = () =>
  model === 'gemini-4-neon'
    ? [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }]
    : [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }];
const opencodeEffortOption = () => {
  if (!OPENCODE_EFFORTS || model === 'fake/two') return [];
  const opts =
    model === 'fake/one'
      ? [{ value: 'minimal' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }, { value: 'default' }]
      : [{ value: 'low' }, { value: 'high' }, { value: 'default' }];
  return [{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: opts }];
};
const configOptions = () =>
  AGY
    ? [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
        { id: 'thinking_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: effort, options: agyThinkingOptions() },
        { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'default' }, { value: 'auto_edit' }, { value: 'yolo' }] },
      ]
    : GROK
    ? [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'grok-4.7', name: 'Grok 4.7' }, { value: 'grok-4.5', name: 'Grok 4.5' }] },
        { id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: effort, options: [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }] },
      ]
    : [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'fake/one', name: 'Fake One' }, { value: 'fake/two', name: 'Fake Two' }] },
        ...opencodeEffortOption(),
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'build', name: 'build' }, { value: 'plan', name: 'plan' }, { value: 'ask', name: 'ask' }, { value: 'agent', name: 'agent' }] },
      ];
const levels = (ids) => ids.map((id) => ({ id, value: id, label: id, default: id === 'high' }));
const agyModels = () => ({
  currentModelId: `${model}-${effort}`,
  availableModels: [
    { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
    { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
    { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
    { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  ],
});
const grokModels = () => ({
  currentModelId: model,
  availableModels: [
    { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { supportsReasoningEffort: true, reasoningEfforts: levels(['xhigh', 'high', 'medium', 'low']) } },
    { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { supportsReasoningEffort: true, reasoningEfforts: levels(['high', 'medium', 'low', 'minimal']) } },
  ],
});

// The plugin from --plugin-dir and its hooks, unless the folder's
// .grok/config.toml turns it off by name, as Grok lets any folder do.
function grokPlugin(cwd) {
  const at = process.argv.indexOf('--plugin-dir');
  if (at < 0) return undefined;
  const plugin = process.argv[at + 1];
  const name = path.basename(plugin);
  try {
    if (fs.readFileSync(path.join(cwd, '.grok', 'config.toml'), 'utf8').includes(`"${name}"`)) return undefined;
  } catch {
    // no folder config
  }
  try {
    return { name, hooks: JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks ?? {} };
  } catch {
    return undefined;
  }
}

// Grok reports the hooks it ran for an event, by name.
function reportHooks(sessionId, event, plugin) {
  const runs = [{ name: 'global/settings:x[0].hooks[0]', status: { status: 'success' } }];
  const key = event === 'user_prompt_submit' ? 'UserPromptSubmit' : 'PreToolUse';
  if (plugin?.hooks[key]?.length) runs.push({ name: `plugin/${plugin.name}/hooks:${event}[0].hooks[0]`, status: { status: 'success' } });
  send({ method: '_x.ai/session_notification', params: { sessionId, update: { sessionUpdate: 'hook_execution', event_name: event, runs } } });
}

// Grok's PreToolUse hooks from --plugin-dir: the first deny wins, then ask.
// A hook that can't run, with failClosed, denies.
function grokHook(sessionId, cwd, toolName, toolInput) {
  const plugin = grokPlugin(cwd);
  reportHooks(sessionId, 'pre_tool_use', plugin);
  if (!plugin) return { decision: 'none' };
  const conf = { hooks: plugin.hooks };
  let out = { decision: 'none' };
  for (const group of conf.hooks?.PreToolUse ?? []) {
    for (const h of group.hooks ?? []) {
      const r = spawnSync(h.command, h.args ?? [], { input: JSON.stringify({ hookEventName: 'pre_tool_use', cwd, toolName, toolInput, toolInputTruncated: false, tool_name: toolName, tool_input: toolInput }), encoding: 'utf8' });
      let reply;
      try {
        reply = JSON.parse(r.stdout);
      } catch {
        reply = undefined;
      }
      if (r.status !== 0 || !reply) {
        if (h.failClosed) return { decision: 'deny', reason: 'hook failed' };
        continue;
      }
      if (reply.decision === 'deny') return { decision: 'deny', reason: reply.reason };
      if (reply.decision === 'ask') out = { decision: 'ask', reason: reply.reason, hookName: `plugin/${plugin.name}/hooks:pre_tool_use[0].hooks[0]` };
    }
  }
  return out;
}

async function grokTool(sessionId, cwd, kind, title, toolName, input, run) {
  const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: toolName, rawInput: input });
  const hook = grokHook(sessionId, cwd, toolName, input);
  log({ hook: { toolName, decision: hook.decision } });
  if (hook.decision === 'deny') {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: `Hook denied: ${hook.reason}` } }] });
    return;
  }
  if (hook.decision === 'ask') {
    const r = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId, kind, title: `${title} — hook '${hook.hookName}' asks: ${hook.reason}`, rawInput: { variant: kind === 'edit' ? 'Write' : kind === 'execute' ? 'Bash' : toolName === 'use_tool' ? 'UseTool' : 'Read', ...input }, ...(input.file_path ? { locations: [{ path: input.file_path }] } : {}) },
      options: [
        { optionId: 'allow-edits-session', kind: 'allow_always', name: 'Yes, allow all edits during this session' },
        { optionId: 'allow-once', kind: 'allow_once', name: 'Yes, proceed' },
        { optionId: 'reject-once', kind: 'reject_once', name: 'No' },
      ],
      _meta: { hookAsk: { hookName: hook.hookName, reason: hook.reason } },
    });
    log({ answered: r });
    if (r.outcome?.outcome !== 'selected' || r.outcome.optionId !== 'allow-once') {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'User rejected' } }] });
      return 'rejected';
    }
  }
  run();
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] });
}

// Grok 1.0.92's frames for a login out of balance (thread ce78609c, 23 Nov
// 2026), trimmed to what matters, with its own ids left out.
const OUT_OF_BALANCE = 'API error (status 402 Payment Required): Grok Build usage balance exhausted';
const GROK_OUT_OF_BALANCE = {
  retry: { sessionUpdate: 'retry_state', type: 'failed', error_type: 'api', message: OUT_OF_BALANCE },
  completed: { sessionUpdate: 'turn_completed', stop_reason: 'error', agent_result: OUT_OF_BALANCE, error: { code: -32603, message: 'Internal error', data: { message: OUT_OF_BALANCE, http_status: 402 } }, elapsed_ms: 1368 },
  answer: { code: -32603, message: 'Internal error', data: { message: OUT_OF_BALANCE, http_status: 402 } },
};

async function grokPrompt(id, p, s, word, rest) {
  reportHooks(p.sessionId, 'user_prompt_submit', grokPlugin(s.cwd));
  if (word === 'broke') {
    const note = (update) => send({ method: '_x.ai/session_notification', params: { sessionId: p.sessionId, update } });
    note(GROK_OUT_OF_BALANCE.retry);
    note(GROK_OUT_OF_BALANCE.completed);
    // FAKE_GROK_BARE_ERROR: an answer with no data, so only the notes say why.
    return send({ id, error: env.FAKE_GROK_BARE_ERROR ? { code: -32603, message: 'Internal error' } : GROK_OUT_OF_BALANCE.answer });
  }
  // A model starts with a thought, and a stopped process stops here.
  update(p.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
  await new Promise((r) => setTimeout(r, 50));
  let rejected;
  if (word === 'write') rejected = await grokTool(p.sessionId, s.cwd, 'edit', `Write \`${rest[0]}\``, 'write', { file_path: rest[0], content: rest.slice(1).join(' ') }, () => fs.writeFileSync(rest[0], rest.slice(1).join(' ')));
  else if (word === 'exec') rejected = await grokTool(p.sessionId, s.cwd, 'execute', `Execute \`${rest.join(' ')}\``, 'run_terminal_command', { command: rest.join(' ') }, () => log({ ran: rest.join(' ') }));
  else if (word === 'read') rejected = await grokTool(p.sessionId, s.cwd, 'read', `Read \`${rest[0]}\``, 'read_file', { target_file: rest[0] }, () => log({ read: rest[0] }));
  else if (word === 'mcp') rejected = await grokTool(p.sessionId, s.cwd, 'other', rest[0], 'use_tool', { tool_name: rest[0], tool_input: {} }, () => log({ mcp: rest[0] }));
  update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'done' } });
  // A rejected call ends Grok's turn, as the real one does.
  send({ id, result: { stopReason: rejected ? 'cancelled' : 'end_turn' } });
}

function asksFor(cwd) {
  if (env.OPENCODE_DISABLE_PROJECT_CONFIG !== '1') {
    try {
      if (JSON.parse(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8')).permission) return false; // the folder's config wins
    } catch {
      // no such file
    }
  }
  try {
    const conf = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
    return conf.permission?.['*'] === 'ask' || conf.permission?.edit === 'ask';
  } catch {
    return false;
  }
}

function deniesAll() {
  try {
    return JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}').permission?.['*'] === 'deny';
  } catch {
    return false;
  }
}

function openedSession(cwd) {
  if (AGY) {
    fs.mkdirSync(path.join(cwd, 'skills', 'system', 'run-workflow'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'skills', 'system', 'run-workflow', 'SKILL.md'), 'a skill');
    return;
  }
  if (env.OPENCODE_DISABLE_PROJECT_CONFIG !== '1' && !process.argv.includes('--pure')) {
    const plugin = path.join(cwd, '.opencode', 'plugins', 'run.txt');
    if (fs.existsSync(plugin)) fs.writeFileSync(fs.readFileSync(plugin, 'utf8').trim(), 'plugin ran');
  }
}

const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

async function runTool(sessionId, cwd, kind, input, locations, run) {
  const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: kind === 'edit' ? 'write' : 'bash', kind, status: 'pending', locations: [], rawInput: {} });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', kind, locations, rawInput: input });
  if (deniesAll()) {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', kind, rawOutput: { error: 'denied by config' } });
    return;
  }
  if (asksFor(cwd)) {
    const r = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId, title: locations[0]?.path ?? input.command, kind, status: 'pending', locations, rawInput: input, ...(kind === 'edit' ? { content: [{ type: 'diff', path: locations[0].path, oldText: '', newText: input.content }] } : {}) },
      options: env.FAKE_ACP_NO_ONCE
        ? [{ optionId: 'always', kind: 'allow_always', name: 'Always allow' }]
        : [
            { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
    });
    log({ answered: r });
    if (r.outcome?.outcome !== 'selected' || r.outcome.optionId === 'reject') {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', kind, content: [{ type: 'content', content: { type: 'text', text: 'rejected' } }], rawOutput: { error: 'rejected' } });
      return;
    }
  }
  run();
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', kind, content: [{ type: 'content', content: { type: 'text', text: 'done' } }] });
}

async function callHttpMcp(server, name, args) {
  const headers = { 'content-type': 'application/json' };
  for (const h of server.headers ?? []) headers[h.name] = h.value;
  const res = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.json();
}

async function prompt(id, p) {
  const s = sessions.get(p.sessionId);
  const text = p.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  log({ prompt: text, blocks: p.prompt.map((b) => b.type) });
  const last = text.split('\n').at(-1).trim();
  const [word, ...rest] = last.split(' ');
  if (word === 'hang') return; // answers only session/cancel
  if (GROK) return grokPrompt(id, p, s, word, rest);
  if (AGY) return agyPrompt(id, p, s, word, rest);
  if (word === 'write') await runTool(p.sessionId, s.cwd, 'edit', { filePath: rest[0], content: rest.slice(1).join(' ') }, [{ path: rest[0] }], () => fs.writeFileSync(rest[0], rest.slice(1).join(' ')));
  else if (word === 'images') {
    for (let i = 0; i < Math.min(65, Number(rest[0])); i++) {
      const toolCallId = `image-${Math.random()}`;
      update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'Picture', kind: 'read', status: 'in_progress' });
      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'image', data: rest[1], mimeType: 'image/png' } }] });
    }
  }
  else if (word === 'exec') await runTool(p.sessionId, s.cwd, 'execute', { command: rest.join(' ') }, [], () => log({ ran: rest.join(' ') }));
  else if (word === 'bg_shell') {
    const spec = JSON.parse(rest.join(' '));
    const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
    const command = spec.command ?? 'sleep 60';
    const description = spec.description;
    const shellId = spec.shellId ?? 'sh_bg1';
    const pid = spec.pid;
    update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId, kind: 'execute', title: command, status: 'in_progress', rawInput: { command, ...(description ? { description } : {}) } });
    const lines = [
      `Command moved to the background (shell ID: ${shellId}).`,
      ...(pid !== undefined ? [`PID: ${pid}`] : []),
      `Output is streaming to: /tmp/${shellId}.out`,
    ];
    const meta = { shellID: shellId, status: spec.status ?? 'running', truncated: false, ...(pid !== undefined ? { pid } : {}) };
    update(p.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }],
      ...(spec.omitRawOutput ? {} : { rawOutput: { metadata: meta } }),
    });
    if (spec.reply !== false) {
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: spec.reply ?? 'Command is running in the background.' } });
    }
    if (spec.sameChunkWake) {
      const w = spec.sameChunkWake;
      const linesOut = [
        JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: p.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: w.toolId ?? 'wake-same-chunk-tool',
              kind: 'execute',
              title: w.command ?? 'check output',
              status: 'in_progress',
              rawInput: { command: w.command ?? 'check output' },
            },
          },
        }),
      ];
      process.stdout.write(linesOut.join('\n') + '\n');
      if (w.finishAfterMs) {
        setTimeout(() => {
          update(p.sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: w.toolId ?? 'wake-same-chunk-tool',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: w.output ?? 'wake output ok' } }],
          });
          if (w.text) update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'bg-same-chunk-m1', content: { type: 'text', text: w.text } });
        }, w.finishAfterMs);
      }
      return;
    }
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  else if (word === 'codemode_end_turn' || word === 'codemode_end_turn_retry' || word === 'direct_end_turn') {
    const server = (s.mcpServers ?? []).find((m) => m.name === 'threadbear' && m.type === 'http');
    const calls = word === 'codemode_end_turn_retry' ? rest.join(' ').split(' || ').map((x) => JSON.parse(x)) : [JSON.parse(rest.join(' '))];
    for (const args of calls) {
      const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
      if (word === 'direct_end_turn') {
        update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'threadbear_end_turn', kind: 'other', status: 'in_progress', rawInput: args });
        const mcpRes = await callHttpMcp(server, 'end_turn', args);
        const outText = mcpRes.result?.content?.[0]?.text ?? '';
        log({ mcpRes });
        update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', kind: 'other', content: [{ type: 'content', content: { type: 'text', text: outText } }] });
      } else {
        update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'execute', name: 'execute', kind: 'other', status: 'in_progress', rawInput: { code: `return await tools.threadbear.end_turn(${JSON.stringify(args)});` } });
        const mcpRes = await callHttpMcp(server, 'end_turn', args);
        const outText = mcpRes.result?.content?.[0]?.text ?? '';
        log({ mcpRes });
        // OpenCode 2 reports execute as status: completed even when the inner MCP tool returned isError.
        update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', kind: 'other', content: [{ type: 'content', content: { type: 'text', text: outText } }] });
      }
    }
  }
  // OpenCode 2's question tool, as a form (when the client offered forms).
  else if (word === 'form') {
    if (!clientForms) log({ form: 'not offered' });
    else
      log({
        formAnswer: await ask('elicitation/create', {
          mode: 'form',
          sessionId: p.sessionId,
          toolCallId: 'q-call',
          message: 'Questions',
          requestedSchema: {
            type: 'object',
            properties: {
              q0: { type: 'string', title: 'Colour', description: 'Which colour?', oneOf: [{ const: 'Blue', title: 'Blue' }, { const: 'Green', title: 'Green' }] },
              q0_custom: { type: 'string', title: 'Colour (other)', description: 'Type your own answer' },
            },
            required: [],
          },
        }),
      });
  }
  update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'all ' } });
  update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'done' } });
  update(p.sessionId, { sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: 0.25, currency: 'USD' } });
  send({ id, result: { stopReason: 'end_turn' } });
}

const AGY_USAGE = `### Session Usage
- **Session total:** data not available yet

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash)*
  - **Weekly Limit Remaining:** 55% remaining (resets Nov 28, 2026, 08:49 UTC)
  - **Five Hour Limit Remaining:** 91% remaining (resets Nov 23, 2026, 09:35 UTC)
- **Claude and GPT models**
  *(Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B)*
  - **Weekly Limit Remaining:** 100% remaining (resets Nov 30, 2026, 05:08 UTC)
  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 23, 2026, 10:08 UTC)
`;

async function agyPrompt(id, p, s, word, rest) {
  if (word === '/usage' && !env.FAKE_ACP_NO_USAGE_COMMAND) {
    log({ usageCommand: true });
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: env.FAKE_ACP_USAGE ?? AGY_USAGE } });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  const tool = async (kind, title, rawInput, extra, run) => {
    const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
    update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput });
    const r = await ask('session/request_permission', {
      sessionId: p.sessionId,
      toolCall: { toolCallId, kind, status: 'pending', title, rawInput, ...extra },
      options: [
        { optionId: 'allow_always', name: 'Allow Always (risky)', kind: 'allow_always' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    log({ answered: r, kind });
    if (r.outcome?.outcome !== 'selected' || r.outcome.optionId !== 'allow') {
      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
      return;
    }
    run();
    update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] });
  };
  const where = s.dirs?.[0] ?? s.cwd;
  if (word === 'exec') await tool('execute', rest.join(' '), { CommandLine: rest.join(' '), Cwd: where, WaitMsBeforeAsync: 5000 }, {}, () => log({ ran: rest.join(' '), in: where }));
  else if (word === 'read') await tool('read', 'Running view_file', { AbsolutePath: rest[0] }, { locations: [{ path: rest[0] }] }, () => log({ read: rest[0] }));
  // Any arguments, as JSON: "execraw {...}", "readraw {...}".
  else if (word === 'execraw') await tool('execute', 'cmd', JSON.parse(rest.join(' ')), {}, () => log({ ran: JSON.parse(rest.join(' ')) }));
  else if (word === 'readraw') {
    const input = JSON.parse(rest.join(' '));
    await tool('read', 'Running view_file', input, input.AbsolutePath ? { locations: [{ path: input.AbsolutePath }] } : {}, () => log({ read: input }));
  }
  // Its create_file, as its frames were on 20 Nov 2026 (1.4.5): a pending
  // "Run create_file?" tool_call and the permission request under an id of
  // their own; once allowed, the tool runs as edit_file under the session's
  // step id, and the request's id is called failed ("approved but never
  // executed") at the end.
  else if (word === 'create') {
    const file = rest[0];
    const text = rest.slice(1).join(' ');
    const asked = Math.random().toString(16).slice(2).padEnd(32, '0');
    const proposed = { toolCallId: asked, title: 'Run create_file?', kind: 'edit', status: 'pending', content: [{ path: file, newText: text, _meta: { kind: 'add' }, type: 'diff' }], locations: [{ path: file }], rawInput: { CodeContent: text, Description: 'make it', Overwrite: true, TargetFile: file } };
    update(p.sessionId, { sessionUpdate: 'tool_call', ...proposed });
    const r = await ask('session/request_permission', {
      sessionId: p.sessionId,
      toolCall: proposed,
      options: [
        { optionId: 'allow_always', name: 'Allow Always (risky)', kind: 'allow_always' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    log({ answered: r, kind: 'edit' });
    if (r.outcome?.outcome === 'selected' && r.outcome.optionId === 'allow') {
      const step = `${p.sessionId}:${++s.steps}`;
      update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: step, title: 'Running edit_file', kind: 'edit', status: 'in_progress', rawInput: { file_path: file } });
      fs.writeFileSync(file, text);
      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: step, status: 'completed', rawOutput: 'Create the file' });
    }
    // At the turn's end it calls the request's id failed.
    update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: asked, status: 'failed', rawOutput: 'Tool call was approved but never executed.' });
  }
  else if (word === 'mcp') {
    const [server, name] = rest[0].split('__');
    await tool('other', `${server}_${name}`, { arguments: {}, }, { _meta: { mcp: { tool: name, server }, is_mcp_tool_call: true } }, () => log({ mcp: rest[0] }));
  }
  else if (word === 'crash_harness') {
    update(p.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Agent execution error: Harness process exited unexpectedly (WS close code 1006).\nHarness stderr:\ncontext canceled' },
    });
    return; // leaves session/prompt hanging, as agy_acp_server does
  }
  else if (word === 'crash_harness_chunked') {
    update(p.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Agent execution error: Harness process exited un' },
    });
    update(p.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'expectedly (WS close code 1006).\nHarness stderr:\ncontext canceled' },
    });
    return; // leaves session/prompt hanging, as agy_acp_server does
  }
  else if (word === 'tool_code_containing_error') {
    const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
    update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'run', kind: 'execute', status: 'in_progress', rawInput: {} });
    update(p.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [{ type: 'text', text: 'const reason = "agent executor error";' }],
      rawOutput: 'const reason = "agent executor error";',
    });
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Discussing Error 429: RESOURCE_EXHAUSTED with the user.' } });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  else if (word.startsWith('message_402') || word === 'message_bare_executor_error') {
    const banner = 'Agent execution terminated due to error.';
    const detail = ' ("agent executor error: Error 402: Billing error")';
    const chunks = word === 'message_402_split' ? [banner, detail] : [word === 'message_402' ? banner + detail : banner];
    for (const text of chunks) update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    return;
  }
  else if (word.startsWith('quota_') || ['rate_limit', 'retry_delay', 'executor_429', 'executor_402', 'split_harness'].includes(word)) {
    const askQuestion = () => ask('elicitation/create', { mode: 'form', sessionId: p.sessionId, message: 'Finish the test prompt?' });
    const allow = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];
    const edit = { kind: 'edit', title: 'Edit before quota', locations: [{ path: path.join(where, 'old.txt') }] };
    const partialEdit = word === 'quota_existing_edit_partial' || word === 'quota_existing_edit_partial_failed';
    if (partialEdit) edit.locations.push({ path: path.join(where, 'other.txt') });
    if (word === 'quota_existing_edit_header') edit.rawInput = { file_path: edit.locations[0].path, content: '# Doc\n--- /example/other.md\n' };
    const oldEdit = word.startsWith('quota_existing_edit')
      ? ask('session/request_permission', { sessionId: p.sessionId, toolCall: { ...edit, toolCallId: 'old-edit-approval', status: 'pending' }, options: allow })
      : undefined;
    const pendingQuestion = word.startsWith('quota_pending_') ? askQuestion() : undefined;
    const startsAfterAnswer = word === 'quota_pending_tool';
    const parallelTool = word.startsWith('quota_parallel_') || startsAfterAnswer ? 'parallel-command' : undefined;
    if (parallelTool) update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: parallelTool, title: 'parallel work', kind: 'execute', status: startsAfterAnswer ? 'pending' : 'in_progress' });
    const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
    update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'run', kind: 'execute', status: 'in_progress', rawInput: {} });
    const reason = {
      rate_limit: ': RESOURCE_EXHAUSTED: quota exceeded for requests per minute. Retry in 1s.',
      retry_delay: ': RESOURCE_EXHAUSTED: Please retry in 1.5s.',
      executor_429: ', Message: Too many requests., Status: RESOURCE_EXHAUSTED',
    }[word] ?? ', Message: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h32m53s., Status: RESOURCE_EXHAUSTED';
    const text = {
      executor_402: 'Agent execution terminated due to error. ("agent executor error: Error 402: Billing error")',
      split_harness: 'Agent execution error: Harness process exited unexpectedly (WS close code 1006).',
    }[word] ?? `Agent execution terminated due to error. ("agent executor error: Error 429${reason}")`;
    const split = ['quota_fail', 'executor_429', 'executor_402', 'split_harness'].includes(word);
    update(p.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      ...(split ? {} : { status: 'failed' }),
      content: [{ type: 'content', content: { type: 'text', text } }],
    });
    if (split) {
      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
      return; // leaves session/prompt hanging, as agy_acp_server does
    }
    if (word === 'quota_end_turn' || word === 'quota_cancelled') return send({ id, result: { stopReason: word === 'quota_cancelled' ? 'cancelled' : 'end_turn' } });
    if (word === 'quota_prompt_error') return send({ id, error: { code: -32603, message: 'Context length exceeded' } });
    if (word === 'quota_new_permission') {
      const recovery = await ask('session/request_permission', {
        sessionId: p.sessionId,
        toolCall: { toolCallId: 'recovery', title: 'New work', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'pwd', Cwd: where } },
        options: allow,
      });
      if (recovery.outcome?.outcome === 'selected') {
        update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'recovery', status: 'in_progress' });
        update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'recovery', status: 'completed' });
      }
      return send({ id, result: { stopReason: 'end_turn' } });
    }
    if (oldEdit) {
      const approved = await oldEdit;
      if (approved.outcome?.outcome === 'selected') {
        if (word === 'quota_existing_edit_relative' || word === 'quota_existing_edit_relative_again' || word === 'quota_existing_edit_patch') {
          if (word === 'quota_existing_edit_patch') {
            update(p.sessionId, { sessionUpdate: 'tool_call', kind: 'edit', toolCallId: 'next-edit', status: 'completed',
              rawInput: { patchText: `*** Begin Patch\n*** Update File: ${path.join(where, 'new.txt')}\n@@\n-a\n+b\n*** End Patch` } });
            return send({ id, result: { stopReason: 'end_turn' } });
          }
          update(p.sessionId, { sessionUpdate: 'tool_call', kind: 'edit', toolCallId: 'next-edit', rawInput: { file_path: 'new.txt' } });
          const locations = [{ path: path.join(where, 'new.txt') }];
          if (word === 'quota_existing_edit_relative_again') {
            update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'next-edit', status: 'in_progress', locations });
            update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'next-edit', status: 'completed', rawInput: { file_path: 'new.txt' } });
          } else {
            update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'next-edit', status: 'completed', locations });
          }
          return send({ id, result: { stopReason: 'end_turn' } });
        }
        const wire = { toolCallId: 'old-edit-running' };
        const first = {
          quota_existing_edit_empty: { ...wire, rawInput: {} },
          quota_existing_edit_no_status: { ...edit, ...wire },
          quota_existing_edit_no_path: { ...wire, kind: 'edit', status: 'in_progress' },
          quota_existing_edit_other: { ...wire, kind: 'other', status: 'in_progress' },
          quota_existing_edit_recovers: { ...wire, kind: 'edit', status: 'in_progress' },
          quota_existing_edit_header: { ...edit, ...wire },
          quota_existing_edit_partial: { ...wire, kind: 'edit', status: 'in_progress', locations: edit.locations.slice(0, 1) },
          quota_existing_edit_partial_failed: { ...wire, kind: 'edit', status: 'pending', locations: edit.locations.slice(0, 1) },
        }[word];
        if (first) update(p.sessionId, { sessionUpdate: 'tool_call', ...first });
        const progress = {
          quota_existing_edit_empty: { rawInput: { file_path: edit.locations[0].path } },
          quota_existing_edit_partial: { locations: edit.locations.slice(0, 1) },
          quota_existing_edit_header: { locations: edit.locations },
        }[word] ?? edit;
        if (word === 'quota_existing_edit_partial_failed') {
          update(p.sessionId, { sessionUpdate: 'tool_call_update', ...wire, status: 'failed' });
        } else {
          update(p.sessionId, { sessionUpdate: first ? 'tool_call_update' : 'tool_call', ...progress, ...wire, status: 'in_progress' });
          update(p.sessionId, { sessionUpdate: 'tool_call_update', ...wire, status: 'completed' });
        }
        if (word === 'quota_existing_edit_recovers' || partialEdit) {
          update(p.sessionId, { sessionUpdate: 'tool_call', ...edit, toolCallId: 'next-edit', status: 'in_progress' });
          update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'next-edit', status: 'completed' });
        }
      }
      return send({ id, result: { stopReason: 'end_turn' } });
    }
    if (word === 'quota_recovers') {
      await tool('read', 'Running view_file', { AbsolutePath: '/tmp/example' }, {}, () => log({ recovered: true }));
    }
    if (word === 'quota_question') {
      await askQuestion();
    } else {
      if (pendingQuestion) {
        await pendingQuestion;
        if (startsAfterAnswer) update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: parallelTool, status: 'in_progress' });
        update(p.sessionId, { sessionUpdate: 'usage_update', used: 42 });
        if (word === 'quota_pending_hangs') return;
      }
      // Let the test advance its clock without sending the client another frame.
      await new Promise((resolve) => pausedPrompts.set(p.sessionId, resolve));
      if (word === 'quota_exit') process.exit(1);
      if (parallelTool) {
        const failed = ['quota_parallel_failure', 'quota_parallel_retry'].includes(word);
        const rawOutput = {
          quota_parallel_failure: 'command failed',
          quota_parallel_retry: 'Agent execution terminated due to error. ("agent executor error: Error 429: RESOURCE_EXHAUSTED: Please retry in 1.5s.")',
        }[word] ?? 'command completed';
        update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: parallelTool, status: failed ? 'failed' : 'completed', rawOutput });
        if (word !== 'quota_parallel_tool') return;
      }
    }
  }
  update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'done' } });
  send({ id, result: { stopReason: 'end_turn' } });
}

let clientForms = false;
const handlers = {
  initialize: (p) => (
    (clientForms = Boolean(p?.clientCapabilities?.elicitation?.form)),
    {
    ...(env.FAKE_ACP_VERSION === 'none' ? {} : { protocolVersion: env.FAKE_ACP_VERSION ? Number(env.FAKE_ACP_VERSION) : 1 }),
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true }, sessionCapabilities: env.FAKE_ACP_NO_RESUME ? { close: {} } : { resume: {}, close: {} } },
    ...(AGY
      ? { authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }], agentInfo: { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.4.5' } }
      : GROK
      ? { authMethods: [{ id: 'cached_token', name: 'cached_token' }, { id: 'grok.com', name: 'Grok' }], _meta: { grokShell: true, agentVersion: '1.0.77' } }
      : { authMethods: AGENT === 'Cursor' ? [{ id: 'cursor_login', name: 'Log in' }] : [{ id: 'opencode-login', name: 'Log in' }], agentInfo: { name: AGENT, version: '9.9.9' } }),
  }),
  'session/new': (p) => {
    if (env.FAKE_ACP_NEEDS_LOGIN) throw Object.assign(new Error('Authentication required'), { code: -32000 });
    const sessionId = `ses-${Math.random().toString(36).slice(2)}`;
    sessions.set(sessionId, { cwd: p.cwd, dirs: p.additionalDirectories, mcpServers: p.mcpServers ?? [], steps: 0 });
    openedSession(p.cwd);
    log({ newSession: { cwd: p.cwd, mcpServers: p.mcpServers, ...(p.additionalDirectories ? { additionalDirectories: p.additionalDirectories } : {}) } });
    if (AGY) {
      const commands = [{ name: 'plan', description: 'Plan carefully' }, { name: 'logout', description: 'Log out' }, ...(env.FAKE_ACP_NO_USAGE_COMMAND ? [] : [{ name: 'usage', description: 'Show model token usage and quota limits.' }])];
      setImmediate(() => update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: commands }));
      return { sessionId, configOptions: configOptions(), models: agyModels(), _meta: { antigravity: { tier: { name: 'Google AI Ultra', id: 'g1-ultra-lite-tier' } } } };
    }
    return { sessionId, configOptions: configOptions(), ...(GROK ? { models: grokModels() } : {}) };
  },
  'session/load': (p) => {
    sessions.set(p.sessionId, { cwd: p.cwd, dirs: p.additionalDirectories, mcpServers: p.mcpServers ?? [], steps: 0 });
    openedSession(p.cwd);
    log({ loaded: p.sessionId, cwd: p.cwd });
    if (env.FAKE_ACP_LOAD_REPLAY_BG) {
      const spec = JSON.parse(env.FAKE_ACP_LOAD_REPLAY_BG);
      update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'replay-bg', kind: 'execute', title: spec.command ?? 'old job', status: 'in_progress', rawInput: { command: spec.command ?? 'old job' } });
      update(p.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'replay-bg',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: `Command moved to the background (shell ID: ${spec.shellId}).\nPID: ${spec.pid}\nOutput is streaming to: /tmp/${spec.shellId}.out` } }],
        rawOutput: { metadata: { shellID: spec.shellId, status: 'running', pid: spec.pid, truncated: false } },
      });
    }
    return { configOptions: configOptions() };
  },
  'session/resume': (p) => {
    if (p.sessionId === 'gone') throw Object.assign(new Error('session not found'), { code: -32002 });
    sessions.set(p.sessionId, { cwd: p.cwd, dirs: p.additionalDirectories, steps: 0 });
    openedSession(p.cwd);
    log({ resumed: p.sessionId, cwd: p.cwd, ...(p.additionalDirectories ? { additionalDirectories: p.additionalDirectories } : {}) });
    return { configOptions: configOptions() };
  },
  'session/close': () => ({}),
  // Grok's own: how much of the plan is used (adapters/acp/grok-billing.ts).
  ...(GROK
    ? {
        '_x.ai/billing': () => {
          log({ billing: true });
          // A Grok that dies before it answers.
          if (env.FAKE_GROK_EXIT_ON_BILLING) process.exit(1);
          if (env.FAKE_GROK_BILLING) return JSON.parse(env.FAKE_GROK_BILLING);
          return {
            config: { creditUsagePercent: 40, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-18T06:53:23.471544+00:00', end: '2026-11-25T06:53:23.471544+00:00' }, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true },
            subscription_tier: 'X Premium+',
          };
        },
      }
    : {}),
  'session/set_config_option': (p) => {
    if (env.FAKE_ACP_NO_SET_MODE && p.configId === 'mode') throw new Error('no such mode');
    if (p.configId === 'mode' && !env.FAKE_ACP_IGNORE_MODE) mode = p.value;
    if (p.configId === 'model') {
      model = p.value;
      if (AGY && model !== 'gemini-4-neon' && effort === 'xhigh') effort = 'high';
    }
    if (p.configId === 'reasoning_effort' || p.configId === 'thinking_level' || p.configId === 'effort') effort = p.value;
    log({ set: { [p.configId]: p.value } });
    return { configOptions: configOptions() };
  },
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m.result ?? m.error);
    waiting.delete(m.id);
    return;
  }
  if (m.method === 'session/cancel') {
    log({ cancelled: true });
    return;
  }
  if (m.method === '_test/finish_prompt') {
    pausedPrompts.get(m.params.sessionId)?.();
    pausedPrompts.delete(m.params.sessionId);
    return;
  }
  if (m.method === '_test/wakeGate') {
    const key = m.params?.key;
    if (key) {
      const fn = wakeGates.get(key);
      if (fn) {
        wakeGates.delete(key);
        fn();
      } else {
        openedWakeGates.add(key);
      }
    }
    return;
  }
  if (m.method === '_test/wake') {
    const p = m.params ?? {};
    const sid = p.sessionId;
    const s = sessions.get(sid);
    void (async () => {
      if (p.thought) update(sid, { sessionUpdate: 'agent_thought_chunk', messageId: 'bg-t1', content: { type: 'text', text: p.thought } });
      if (p.tool) {
        const tcId = p.tool.id ?? `bg-tool-${Math.random().toString(36).slice(2)}`;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: tcId, kind: p.tool.kind ?? 'execute', title: p.tool.command ?? 'check', status: 'in_progress', rawInput: p.tool.rawInput ?? { command: p.tool.command ?? 'check' } });
        if (p.tool.askPermission) {
          const ans = await ask('session/request_permission', {
            sessionId: sid,
            toolCall: { toolCallId: tcId, kind: p.tool.kind ?? 'execute', title: p.tool.command ?? 'check', rawInput: p.tool.rawInput ?? { command: p.tool.command ?? 'check' } },
            options: [
              { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'no', kind: 'reject_once', name: 'Deny' },
            ],
          });
          log({ wakeAnswered: ans });
        }
        if (p.tool.waitGate) await waitWakeGate(p.tool.waitGate);
        if (!p.tool.leaveOpen) {
          update(sid, {
            sessionUpdate: 'tool_call_update',
            toolCallId: tcId,
            status: p.tool.failed ? 'failed' : 'completed',
            content: [{ type: 'content', content: { type: 'text', text: p.tool.output ?? 'ok' } }],
            ...(p.tool.rawOutput !== undefined ? { rawOutput: p.tool.rawOutput } : {}),
          });
        }
      }
      if (p.text) update(sid, { sessionUpdate: 'agent_message_chunk', messageId: p.messageId ?? 'bg-m1', content: { type: 'text', text: p.text } });
      if (p.endTurnGate) await waitWakeGate(p.endTurnGate);
      if (p.endTurn) {
        const server = (s?.mcpServers ?? []).find((srv) => srv.name === 'threadbear' && srv.type === 'http');
        const tcId = `bg-end-${Math.random().toString(36).slice(2)}`;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: tcId, title: 'threadbear_end_turn', kind: 'other', status: 'in_progress', rawInput: p.endTurn });
        const mcpRes = server ? await callHttpMcp(server, 'end_turn', p.endTurn) : undefined;
        log({ wakeMcpRes: mcpRes });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: tcId, status: 'completed', kind: 'other', content: [{ type: 'content', content: { type: 'text', text: mcpRes?.result?.content?.[0]?.text ?? 'Noted.' } }] });
      }
      if (p.textAfterEndTurn) {
        if (p.textAfterEndTurnGate) await waitWakeGate(p.textAfterEndTurnGate);
        update(sid, { sessionUpdate: 'agent_message_chunk', messageId: p.messageId ?? 'bg-m2', content: { type: 'text', text: p.textAfterEndTurn } });
      }
    })();
    return;
  }
  if (m.method === 'session/prompt') {
    void prompt(m.id, m.params);
    if (m.params.prompt.some((b) => b.type === 'text' && b.text.trim().split('\n').at(-1) === 'hang')) hanging.push(m.id);
    return;
  }
  const h = handlers[m.method];
  if (m.id === undefined) return;
  if (!h) return send({ id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  try {
    const result = h(m.params);
    if (m.method === 'session/set_config_option' && env.FAKE_ACP_SLOW_SET) return void setTimeout(() => send({ id: m.id, result }), Number(env.FAKE_ACP_SLOW_SET));
    send({ id: m.id, result });
  } catch (e) {
    send({ id: m.id, error: { code: e.code ?? -32603, message: e.message } });
  }
});
const hanging = [];
const wakeGates = new Map();
const openedWakeGates = new Set();
function waitWakeGate(key) {
  if (openedWakeGates.delete(key)) return Promise.resolve();
  return new Promise((resolve) => wakeGates.set(key, resolve));
}
process.on('SIGTERM', () => process.exit(0));
