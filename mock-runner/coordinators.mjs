// Opt-in project-home examples; the ordinary mock fixtures stay unchanged.
export function coordinatorDemo({ threads, projects, broadcast, projectChanged, threadChanged, accountFor, error }) {
  const coordinators = [];
  const now = () => new Date().toISOString();
  const publish = () => broadcast('coordinators.updated', { coordinators });
  const project = (id) => projects.find((p) => p.id === id);
  const make = (p, selection = {}) => {
    const ts = now();
    const id = `coordinator_${p.id}`;
    const events = [
      { type: 'user.message', text: `Keep ${p.title} moving. Bring me the decisions that need me and keep the project notes current.`, images: [] },
      { type: 'turn.started' },
      { type: 'assistant.text', itemId: 'coordinator_reply', text: 'The project home is taking shape. Two helpers are working on the conversation layout and keeping project notes in sync.\n\nI will bring their results together here. You can follow the current work in Highlights, or read the details in Activity.' },
      { type: 'turn.completed', outcome: 'completed', needs: 'nothing', durationMs: 1200 },
    ].map((e, i) => ({ ...e, seq: i + 1, ts, threadId: id, turnId: 'coordinator_first' }));
    const summary = {
      id, title: p.title, cwd: p.folders[0], accountId: accountFor(selection), poolId: selection.poolId, model: selection.model, effort: selection.effort, provider: 'claude', permissionMode: 'full',
      status: 'idle', needsYou: false, coordinatorProjectId: p.id, createdAt: ts, updatedAt: ts, lastActivityAt: ts,
      preview: 'Two helpers are working on the project home.', lastSeq: events.length, lastSeenSeq: events.length,
      projects: [{ id: p.id, title: p.title, by: 'mike', pinned: true }],
      subagents: [
        { id: 'helper_layout', description: 'Build the project conversation layout', status: 'running', startedAt: ts },
        { id: 'helper_notes', description: 'Keep the project notes in sync', status: 'running', startedAt: ts },
      ],
    };
    const subagentEvents = new Map(summary.subagents.map((helper) => [helper.id, [
      { type: 'user.message', text: helper.description, images: [] },
      { type: 'assistant.text', itemId: `${helper.id}_reply`, text: 'The shared project fields are the source of truth. I am checking the project home against the approved layout.' },
    ].map((event, i) => ({ ...event, seq: i + 1, ts, turnId: helper.id }))]));
    threads.set(id, { summary, events, subagentEvents, inProgress: new Map(), timers: [] });
    const coordinator = {
      projectId: p.id, threadId: id, state: 'active', charter: 'Keep the project moving and bring decisions to Mike.', interests: [], updatedAt: ts,
      tasks: [
        { id: 'layout', state: 'working', title: 'Build the project home', doneWhen: 'The conversation and project document match the approved layout.', run: { agentId: 'helper_layout', status: 'running' } },
        { id: 'notes', state: 'working', title: 'Keep project notes in sync', doneWhen: 'Edits from the coordinator and project page share the same document.', run: { agentId: 'helper_notes', status: 'running' } },
        { id: 'research', state: 'done', title: 'Compare the Prints document model', doneWhen: 'The focused document approach is included in the design.', run: { status: 'completed', summary: 'The project document uses the existing shared goals, state and notes.' } },
      ],
      loops: p.title === 'Threadbear' ? [
        {
          id: 'loop_answered',
          kind: 'user_question',
          state: 'answered',
          title: 'Do open questions stay pinned when new turns arrive?',
          summary: 'Yes. Open questions stay pinned at the top of Highlights until you explicitly close them.',
          options: [],
          sourceSeq: 3,
          createdAt: ts,
          updatedAt: ts,
        },
        {
          id: 'loop_decision',
          kind: 'waiting_on_user',
          state: 'open',
          title: 'Collapse technical notes behind Agent memory by default?',
          summary: 'Keeps technical specs out of your project brief until you expand the drawer.',
          options: ['Collapse by default', 'Keep expanded'],
          sourceSeq: 3,
          createdAt: ts,
          updatedAt: ts,
        },
        {
          id: 'loop_checking',
          kind: 'user_question',
          state: 'open',
          title: 'Check whether iPhone needs the same open loops drawer',
          options: [],
          createdAt: ts,
          updatedAt: ts,
        },
      ] : [],
    };
    coordinators.push(coordinator);
    return coordinator;
  };
  const initial = projects.find((p) => p.title === 'Threadbear');
  if (initial) {
    initial.goals = 'Make Threadbear a place to talk to a project, follow its work and make the decisions that need you.';
    initial.state = 'The coordinator experiment is being built. Two helpers are working on the project home and shared notes. The approved design keeps the conversation beside a living project document.';
    initial.notes = '## Decisions\n\n- Use the same pools and model picker as ordinary threads.\n- Routine work stays in helpers, outside the inbox.\n- Keep questions with the coordinator.\n- Project goals, state and notes are shared with the project page.\n\n## Runner & Storage\n\n- Coordinator state persists in `coordinators.json`.\n- `loops` survives reloads and merges cleanly with legacy records.';
    make(initial);
  }
  function publishAsk(coordinator, asks, carriedAsks) {
    const entry = threads.get(coordinator.threadId);
    const ts = now();
    const turnId = `coordinator_ask_${entry.events.length}`;
    for (const e of [
      { type: 'turn.started' },
      { type: 'assistant.text', itemId: `${turnId}_reply`, text: carriedAsks ? 'A helper checked the project brief.' : 'One decision for you before the helpers carry on.' },
      { type: 'turn.completed', outcome: 'completed', needs: 'you', asks, durationMs: 900, ...(carriedAsks ? { carriedAsks } : {}) },
    ]) {
      const event = { ...e, seq: entry.events.length + 1, ts, threadId: coordinator.threadId, turnId };
      entry.events.push(event);
      broadcast('thread.event', { threadId: coordinator.threadId, event });
    }
    const seq = entry.events.length;
    Object.assign(entry.summary, { needsYou: true, needs: 'you', asks, asksSeq: seq, lastSeq: seq, lastSeenSeq: seq, updatedAt: ts, lastActivityAt: ts });
    threadChanged(coordinator.threadId);
  }
  function resolveAsk(entry, taskId) {
    const { summary } = entry;
    const asks = summary.asks;
    const index = asks?.findIndex((ask) => ask.taskId === taskId) ?? -1;
    if (index < 0) return;
    const previous = entry.events.findLast((event) => event.type === 'asks.ticked' && event.asksSeq === summary.asksSeq)?.resolved ?? [];
    const resolved = [...new Set([...previous, index])].sort((a, b) => a - b);
    summary.asks = asks.map((ask, position) => resolved.includes(position) ? { ...ask, ticked: true } : ask);
    const ticked = summary.asks.flatMap((ask, position) => ask.ticked ? [position] : []);
    const event = {
      type: 'asks.ticked', asksSeq: summary.asksSeq, ticked, resolved,
      seq: entry.events.length + 1, ts: now(), threadId: summary.id,
    };
    entry.events.push(event);
    summary.lastSeq = event.seq;
    if (resolved.length === asks.length) {
      Object.assign(summary, { needsYou: false, needs: 'nothing' });
      delete summary.asks;
      delete summary.asksSeq;
    }
    broadcast('thread.event', { threadId: summary.id, event });
    threadChanged(summary.id);
  }

  return async (method, p) => {
    if (method === 'coordinators.list') return { coordinators };
    const target = project(p.projectId ?? initial?.id);
    if (!target) throw error(-32602, 'Project not found.');
    let coordinator = coordinators.find((c) => c.projectId === target.id);
    if (method === 'coordinators.get') return { coordinator: coordinator ?? null };
    if (method === 'coordinators.start') {
      if (!coordinator) coordinator = make(target, p);
      publish();
      threadChanged(coordinator.threadId);
      return { coordinator, thread: threads.get(coordinator.threadId).summary };
    }
    if (!coordinator) throw error(-32602, 'This project has no coordinator.');
    if (method === 'coordinators.pause') {
      coordinator.state = p.paused ? 'paused' : 'active';
      for (const task of coordinator.tasks) {
        if (p.paused && task.run?.status === 'running') { task.run.status = 'interrupted'; task.state = 'blocked'; }
      }
      if (p.paused) for (const helper of threads.get(coordinator.threadId).summary.subagents) {
        if (helper.status === 'running') helper.status = 'stopped';
      }
      threadChanged(coordinator.threadId);
    } else if (method === 'mock.coordinatorTaskBoard') {
      coordinator.taskBoard = taskBoardFixture(coordinator.threadId, now());
      const decision = coordinator.taskBoard.tasks[0];
      publishAsk(coordinator, [{
        action: decision.title, taskId: decision.id, why: decision.now,
        options: decision.decision.options.map((o) => o.label),
        optionNotes: decision.decision.options.map((o) => o.does),
        suggested: 0,
      }]);
      decision.source.seq = threads.get(coordinator.threadId).summary.asksSeq;
    } else if (method === 'coordinators.addToCoordinator') {
      const text = String(p.text ?? '').trim();
      if (!text || !coordinator.taskBoard) throw error(-32602, 'Open a task board and add a request first.');
      // Give the application time to draw its pending state. The real runner
      // acknowledges the request as soon as it has queued it.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      coordinator.taskBoard.tasks.push({
        id: `request_${coordinator.taskBoard.tasks.length}`, title: text, kind: 'action',
        owner: { kind: 'agent' }, state: 'todo',
      });
    } else if (method === 'coordinators.updateWorkItem') {
      const item = coordinator.taskBoard?.workItems.find((w) => w.id === p.workItemId);
      if (!item) throw error(-32602, 'Work item not found.');
      item.collapsed = p.collapsed;
    } else if (['coordinators.answerDecision', 'coordinators.postponeTask', 'coordinators.markTaskDone', 'coordinators.closeTask', 'coordinators.reopenTask'].includes(method)) {
      const task = coordinator.taskBoard?.tasks.find((t) => t.id === p.taskId);
      if (!task) throw error(-32602, 'Task not found.');
      const entry = threads.get(coordinator.threadId);
      if (task.needsYou && p.asksSeq !== entry.summary.asksSeq) {
        throw error(-32602, 'That decision card has changed.');
      }
      if (method === 'coordinators.answerDecision' || method === 'coordinators.postponeTask') {
        if (task.kind !== 'decision' || task.state !== 'todo') throw error(-32602, 'Choose an open decision.');
        if (method === 'coordinators.answerDecision') {
          task.state = 'done';
          task.decision.answer = p.answer;
        } else {
          task.state = 'postponed';
          task.due = p.due.type === 'after_task' ? p.due : {
            type: 'at', at: p.due.at ?? (p.due.date ? new Date(`${p.due.date}T09:00:00`).toISOString() : atNine(1)),
          };
        }
        if (task.needsYou) {
          delete task.needsYou;
          resolveAsk(entry, task.id);
        }
      } else if (method === 'coordinators.reopenTask') {
        if (!task.canReopen) throw error(-32602, 'Only a confirmed task can be reopened.');
        task.state = 'ready_to_close';
        delete task.canReopen;
      } else {
        if (method === 'coordinators.closeTask') {
          if (task.state !== 'ready_to_close') throw error(-32602, 'Wait until the task is ready to close.');
          task.canReopen = true;
        } else if (task.owner.kind !== 'user') throw error(-32602, 'Choose an action owned by you.');
        if (task.state === 'postponed') delete task.due;
        task.state = 'done';
      }
    } else if (method === 'coordinators.addTask') {
      if (!p.title?.trim() || !p.doneWhen?.trim()) throw error(-32602, 'Add a title and what finished looks like.');
      coordinator.tasks.push({ id: `todo_${coordinator.tasks.length}`, state: 'todo', title: p.title, doneWhen: p.doneWhen });
    } else if (method === 'coordinators.closeLoop') {
      const loop = coordinator.loops.find((l) => l.id === p.loopId);
      if (!loop) throw error(-32602, 'Loop not found.');
      const ts = now();
      loop.state = 'closed';
      loop.updatedAt = ts;
      loop.closedAt = ts;
    } else if (method === 'coordinators.reopenLoop') {
      const loop = coordinator.loops.find((l) => l.id === p.loopId);
      if (!loop) throw error(-32602, 'Loop not found.');
      loop.state = loop.kind === 'user_question' && loop.summary ? 'answered' : 'open';
      loop.updatedAt = now();
      delete loop.closedAt;
    } else if (method === 'coordinators.replyLoop') {
      if (coordinator.state === 'paused') throw error(-32602, 'Coordinator is paused. Resume it before replying.');
      const loop = coordinator.loops.find((l) => l.id === p.loopId);
      if (!loop) throw error(-32602, 'Loop not found.');
      const text = String(p.text ?? '').trim();
      if (!text) throw error(-32602, 'Add a reply first.');
      const ts = now();
      const shouldClose = p.close ?? (loop.kind === 'waiting_on_user');
      if (shouldClose) {
        loop.state = 'closed';
        loop.closedAt = ts;
      } else {
        loop.state = 'open';
        delete loop.closedAt;
      }
      loop.updatedAt = ts;
      const entry = threads.get(coordinator.threadId);
      if (entry) {
        const seq = entry.events.length + 1;
        const event = { type: 'user.message', text: `Re: ${loop.title}\n\n${text}`, images: [], seq, ts, threadId: coordinator.threadId, turnId: `loop_reply_${seq}` };
        entry.events.push(event);
        entry.summary.lastSeq = seq;
        entry.summary.lastSeenSeq = seq;
        entry.summary.updatedAt = ts;
        entry.summary.lastActivityAt = ts;
        broadcast('thread.event', { threadId: coordinator.threadId, event });
        threadChanged(coordinator.threadId);
      }
    } else if (method === 'coordinators.update') {
      if (p.charter !== undefined) coordinator.charter = p.charter;
      if (p.interests !== undefined) coordinator.interests = p.interests;
    } else if (method === 'mock.coordinatorFinish') {
      coordinator.tasks[0].run.status = 'completed';
      coordinator.tasks[0].state = 'review';
      const helper = threads.get(coordinator.threadId).summary.subagents[0];
      helper.status = 'completed';
      helper.summary = 'The conversation and living document match the approved layout.';
      threadChanged(coordinator.threadId);
      target.state = 'The project home helper has returned. The coordinator is checking its result before marking the work done.';
      target.stateUpdatedAt = now();
      projectChanged();
    } else if (method === 'mock.coordinatorNotesChanged') {
      // A notification still in flight: projects.update must reject the old
      // baseline, then projects.get gives the editor the version to review.
      target.notes = String(p.text);
      target.updatedAt = now();
    } else if (method === 'mock.coordinatorAsk') {
      // The legacy fixture keeps its Needs you card and Open loops.
      const decision = coordinator.loops.find((l) => l.kind === 'waiting_on_user');
      const entry = threads.get(coordinator.threadId);
      const last = p.carry && entry.events.findLast((e) => e.seq === entry.summary.asksSeq);
      const carried = last ? { seq: last.carriedAsks?.seq ?? last.seq } : undefined;
      publishAsk(coordinator, [{ action: decision.title, why: decision.summary, options: decision.options }], carried);
    } else if (method === 'mock.coordinatorVerify') {
      coordinator.tasks[0].state = 'done';
      target.state = 'The project home is ready. The coordinator checked the helper result and the conversation and living document use the same project state.';
      target.stateUpdatedAt = now();
      projectChanged();
    } else throw error(-32601, 'Unknown coordinator method.');
    for (const item of coordinator.taskBoard?.workItems ?? []) {
      const tasks = coordinator.taskBoard.tasks.filter((t) => !t.parentTaskId && t.workItemId === item.id);
      item.progress = { done: tasks.filter((t) => t.state === 'done').length, total: tasks.length };
    }
    coordinator.updatedAt = now();
    publish();
    return { coordinator };
  };
}

function taskBoardFixture(threadId, updatedAt) {
  const action = (id, title, owner, state, fields = {}) => ({ id, title, kind: 'action', owner, state, ...fields });
  const agent = { kind: 'agent' };
  const user = { kind: 'user' };
  const at = atNine(2);
  return {
    workItems: [
      { id: 'getting-there', title: 'Getting there', collapsed: false },
      { id: 'filming', title: 'Filming', collapsed: true },
    ],
    tasks: [
      {
        id: 'parking', title: 'Airport parking', kind: 'decision', owner: user, state: 'todo',
        workItemId: 'getting-there', needsYou: true, updatedAt, source: { threadId },
        now: 'LongTerm D is A$109 online and can be changed up to two hours before arrival.',
        doneWhen: 'You have chosen who books the parking.',
        due: { type: 'at', at },
        decision: {
          options: [
            { label: 'Prepare the booking for me', does: 'You can check the dates before paying.' },
            { label: 'I’ll book it myself', does: 'Use the car park quote in the source thread.' },
          ],
          recommendation: 'Prepare the booking for me',
        },
      },
      action('prices', 'Compare car parks', agent, 'done', { workItemId: 'getting-there', parentTaskId: 'parking' }),
      action('data', 'Check US data plans', agent, 'working', { workItemId: 'getting-there', source: { threadId: 'helper_layout', runId: 'run-data' } }),
      action('barry', 'Reconfirm pickup with Barry', user, 'todo', {
        workItemId: 'getting-there', due: { type: 'at', at },
        now: 'Barry offered a lift on Saturday.', doneWhen: 'Barry has confirmed the pickup time.',
      }),
      action('pdfs', 'Check PDFs offline', user, 'postponed', {
        workItemId: 'getting-there', due: { type: 'after_task', taskId: 'parking' },
      }),
      action('flights', 'Save flight details', agent, 'done', { workItemId: 'getting-there' }),
      action('interviews', 'Confirm interviews', { kind: 'person', name: 'Wayne' }, 'waiting', { workItemId: 'filming' }),
      action('shot-list', 'Read the one-page shot list', agent, 'ready_to_close', { now: 'The draft is ready to read.', source: { threadId, seq: 3 } }),
    ],
  };
}

function atNine(daysAway) {
  const day = new Date();
  day.setDate(day.getDate() + daysAway);
  day.setHours(9, 0, 0, 0);
  return day.toISOString();
}
