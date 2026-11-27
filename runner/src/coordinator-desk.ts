import { z } from 'zod';
import { parseWhen } from './when.ts';

export const runStates = ['queued', 'running', 'interrupted', 'completed', 'failed', 'stopped'] as const;
const runSchema = z.object({
  id: z.string(),
  agentId: z.string().optional(),
  helperThreadId: z.string().optional(),
  nativeTaskId: z.string().optional(),
  nativeRunId: z.string().optional(),
  status: z.enum(runStates),
  summary: z.string().optional(),
  brief: z.string(),
  updatedAt: z.string(),
  // Registry only (not in the view): an interrupted run a runner stop cut
  // off, for the next runner to carry on by itself (`update`: a handover or a
  // clean stop; `stop`: a crash or a power cut). See carryOnAfterRestart().
  restart: z.enum(['update', 'stop']).optional(),
  // How many times the runner has carried this run on after a restart, and
  // how many of those in a row came after a crash.
  restartResumes: z.number().int().nonnegative().optional(),
  crashResumes: z.number().int().nonnegative().optional(),
  // Updates sent while the run was active may still be waiting in the CLI
  // when it is stopped. The restart recap carries them with their ceilings.
  updates: z.array(z.object({ text: z.string(), ceiling: z.enum(['ask', 'auto', 'full', 'plan']) })).optional(),
  updateWithheld: z.literal(true).optional(),
});
const taskStates = ['todo', 'working', 'blocked', 'review', 'done'] as const;
export type LegacyTaskState = typeof taskStates[number];
export const loopKinds = ['user_question', 'waiting_on_user'] as const;
const loopStates = ['open', 'answered', 'closed'] as const;
export type LoopKind = typeof loopKinds[number];
export type LoopState = typeof loopStates[number];

const nonblank = z.string().trim().min(1);
const idSchema = z.string().refine((id) => id.trim().length > 0, 'Missing identity');
const isoTime = z.iso.datetime({ offset: true });
const atDue = z.object({ type: z.literal('at'), at: isoTime, preset: z.enum(['tomorrow', 'date']).optional() });
const afterDue = z.object({ type: z.literal('after_task'), taskId: idSchema });
const dueSchema = z.discriminatedUnion('type', [atDue, afterDue]);
export const dueInputSchema = z.discriminatedUnion('type', [
  atDue, afterDue,
  z.object({ type: z.literal('tomorrow') }),
  z.object({ type: z.literal('date'), date: z.iso.date() }),
]);
export type TaskDue = z.infer<typeof dueSchema>;
export type TaskDueInput = z.input<typeof dueInputSchema>;

export function resolveTaskDue(input: TaskDueInput, now: number): TaskDue {
  const due = dueInputSchema.parse(input);
  if (due.type === 'at' || due.type === 'after_task') return due;
  const at = due.type === 'tomorrow' ? parseWhen('tomorrow', now) : new Date(`${due.date}T09:00:00`).toISOString();
  return { type: 'at', at, preset: due.type };
}

export const ownerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('agent') }),
  z.object({ kind: z.literal('person'), name: nonblank.max(200) }),
]);
const sourceSchema = z.object({
  threadId: idSchema.optional(), runId: idSchema.optional(), seq: z.number().int().nonnegative().optional(),
});
export const optionSchema = z.object({ label: nonblank.max(240), does: nonblank.max(1000).optional() });
const decisionSchema = z.object({
  options: z.array(optionSchema).max(4).optional(),
  recommendation: nonblank.max(1000).optional(),
  answer: nonblank.max(4000).optional(),
});
const detailsSchema = z.object({
  owner: ownerSchema, now: nonblank.max(1000).optional(),
  doneWhen: z.string().trim().refine((value) => value.length > 0 && value.length <= 1000, 'doneWhen must contain 1 to 1000 characters.').optional(),
  source: sourceSchema.optional(), workItemId: idSchema.optional(), parentTaskId: idSchema.optional(),
  due: dueSchema.optional(), state: z.literal('postponed').optional(),
  openState: z.enum(['working', 'waiting']).optional(),
});
export const taskDetailsSchema = z.discriminatedUnion('kind', [
  detailsSchema.extend({ kind: z.literal('action'), decision: z.never().optional() }),
  detailsSchema.extend({ kind: z.literal('decision'), decision: decisionSchema.optional() }),
]).refine((work) => work.state !== 'postponed' || work.due !== undefined, 'A postponed task needs a due trigger');
export type TaskDetails = z.infer<typeof taskDetailsSchema>;

export const workItemSchema = z.object({ id: idSchema, title: nonblank.max(200), collapsed: z.boolean().default(false) });
export type WorkItem = z.infer<typeof workItemSchema>;
const askedSchema = z.object({ seq: z.number().int().nonnegative(), action: nonblank });
const registryTaskFields = { asked: askedSchema.optional(), designReviewId: z.string().optional() };
const legacyTaskSchema = z.object({ id: z.string(), title: z.string(), doneWhen: z.string(), state: z.enum(taskStates) });
const storedTaskSchema = legacyTaskSchema.partial({ state: true }).extend({
  ...registryTaskFields, reviewNoted: z.string().optional(), closedByUser: z.literal(true).optional(),
  run: runSchema.passthrough().optional(), work: taskDetailsSchema.optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
}).passthrough().transform((t) => ({
  ...t, state: t.state ?? (t.run?.status === 'completed' ? 'review' : t.run ? 'blocked' : 'todo'),
}));
const questionSchema = z.object({ id: z.string(), agentId: z.string(), questions: z.array(z.object({ question: z.string() }).passthrough()), state: z.enum(['open', 'answered']), answer: z.string().optional() });
const loopSchema = z.object({
  id: z.string(),
  kind: z.enum(loopKinds),
  state: z.enum(loopStates),
  title: z.string(),
  summary: z.string().optional(),
  options: z.array(z.string()).max(4).optional(),
  sourceSeq: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});
const storedLoopSchema = loopSchema.extend({ ...registryTaskFields, closedByUser: z.literal(true).optional(), work: taskDetailsSchema.optional() }).passthrough();
export type CoordinatorLoop = z.infer<typeof storedLoopSchema>;
const eventSchema = z.object({ key: z.string(), text: z.string(), taskWake: z.string().optional() }).passthrough();
const recordSchema = z.object({
  projectId: z.string(), threadId: z.string(), state: z.enum(['active', 'paused']), charter: z.string(),
  interests: z.array(z.string()).max(40), tasks: z.array(storedTaskSchema).max(100), questions: z.array(questionSchema.passthrough()).max(100),
  loops: z.array(storedLoopSchema).max(100).default([]),
  workItems: z.array(workItemSchema).default([]), retiredLoops: z.array(storedLoopSchema).default([]),
  updatedAt: z.string(), wakeAt: z.string().optional(), selectedTaskId: z.string().optional(), events: z.array(eventSchema), seen: z.array(z.string()).max(256),
  delivery: z.object({ id: z.string(), text: z.string(), eventKeys: z.array(z.string()), wakeAt: z.string().optional() }).passthrough().optional(),
  // Helper results saved with their run's end (onHelperTurn), kept until
  // the coordinator's turn that reads one finishes (observe). `sentAs` is the
  // turn it went as; `attempt` counts sends. No cap here: a registry that
  // fails to parse stops the runner, so onHelperTurn bounds it instead.
  reports: z.array(z.object({ id: z.string(), text: z.string(), at: z.string().optional(), attempt: z.number().int().optional(), sentAs: z.string().optional() }).passthrough()).optional(),
  // Set with helper runs a restart or handover interrupted, cleared once the
  // coordinator is woken for them (start()): saved, so a crash or a handover
  // before that wake doesn't lose it.
  // Retired: the restart wake is a report now (restartReport). Read only to
  // turn into one, whatever shape an earlier build saved it in.
  wakeInterrupted: z.union([z.string(), z.boolean()]).optional(),
}).passthrough();

export type Coordinator = z.infer<typeof recordSchema>;
export type LegacyTask = Coordinator['tasks'][number];
type BackingTask = LegacyTask | CoordinatorLoop;

export function defaultTaskDetails(): TaskDetails {
  return { kind: 'action', owner: { kind: 'agent' } };
}

function defaultLoopDetails(loop: CoordinatorLoop): TaskDetails {
  return loop.kind === 'waiting_on_user' ? { kind: 'decision', owner: { kind: 'user' } } : defaultTaskDetails();
}

export function getTaskDetails(row: BackingTask): TaskDetails {
  return row.work ?? (isLoop(row) ? defaultLoopDetails(row) : defaultTaskDetails());
}

function isLoop(record: BackingTask): record is CoordinatorLoop {
  return record.state === 'open' || record.state === 'answered' || record.state === 'closed';
}

export function boardRecords(row: Coordinator): BackingTask[] {
  return [...row.tasks, ...row.loops, ...row.retiredLoops];
}

export function isTaskDone(record: BackingTask): boolean {
  return record.state === 'done' || record.state === 'closed';
}

export function validateTaskBoard(row: Coordinator): string | undefined {
  const groups = new Set(row.workItems.map((item) => item.id));
  if (groups.size !== row.workItems.length) return 'Duplicate work item id.';
  const records = boardRecords(row);
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== records.length) return 'Duplicate task id.';
  for (const record of records) {
    const work = getTaskDetails(record);
    if (work.workItemId && !groups.has(work.workItemId)) return 'That work item is not on this desk.';
    if (work.parentTaskId) {
      if (isLoop(record)) return 'A legacy loop cannot be a sub-task.';
      const parent = byId.get(work.parentTaskId);
      if (!parent) return 'That parent task is not on this desk.';
      if (parent === record || parent.work?.parentTaskId) return 'Sub-tasks can only be one level deep.';
      if (work.workItemId) return 'A sub-task inherits its work item from its parent.';
    }
    if (work.openState && record.state !== 'open') return 'Only open loops can carry an open-loop work state.';
    if (work.state !== 'postponed') continue;
    if (isTaskDone(record) || (!isLoop(record) && (record.run?.status === 'queued' || record.run?.status === 'running'))) {
      return 'Done tasks and tasks with a running helper cannot be postponed.';
    }
    if (work.due?.type !== 'after_task') continue;
    const visited = new Set([record.id]);
    let id = work.due.taskId;
    while (true) {
      if (visited.has(id)) return 'Task dependencies cannot form a cycle.';
      const dependency = byId.get(id);
      if (!dependency) return 'That dependency task is not on this desk.';
      const next = dependency.work?.state === 'postponed' ? dependency.work.due : undefined;
      if (next?.type !== 'after_task') break;
      visited.add(id);
      id = next.taskId;
    }
  }
  return undefined;
}

export function ensureTaskDetails(row: Coordinator): void {
  for (const record of boardRecords(row)) record.work ??= getTaskDetails(record);
}

function validateDesk(row: Coordinator): Coordinator {
  const problem = validateTaskBoard(row);
  if (problem) throw new Error(problem);
  ensureTaskDetails(row);
  return row;
}

export function migrateCoordinatorRegistry(input: unknown): Coordinator[] {
  return z.array(recordSchema).parse(input).map(validateDesk);
}

const historyTaskSchema = z.object({
  projectId: z.string(), task: storedTaskSchema, questions: z.array(questionSchema.passthrough()),
});
const historySchema = z.union([
  z.object({ coordinator: recordSchema, removedAt: z.string() }).passthrough(),
  historyTaskSchema.extend({ archivedAt: z.string() }).passthrough(),
  historyTaskSchema.extend({ droppedAt: z.string(), reason: z.string() }).passthrough(),
]);
export type CoordinatorHistoryEntry = z.infer<typeof historySchema>;

export function migrateCoordinatorHistoryEntry(input: unknown): CoordinatorHistoryEntry {
  const entry = historySchema.parse(input);
  if (hasRemovedDesk(entry)) validateDesk(entry.coordinator);
  else entry.task.work ??= defaultTaskDetails();
  return entry;
}

export function hasRemovedDesk(entry: CoordinatorHistoryEntry): entry is Extract<CoordinatorHistoryEntry, { removedAt: string }> {
  return 'removedAt' in entry;
}

const states = {
  todo: 'todo', working: 'working', blocked: 'waiting', review: 'ready_to_close', done: 'done',
  open: 'todo', answered: 'ready_to_close', closed: 'done',
} as const;
export type TaskState = (typeof states)[keyof typeof states] | 'postponed';
export type UnpostponedTaskState = Exclude<TaskState, 'postponed'>;
export const legacyStateFor: Record<UnpostponedTaskState, LegacyTaskState> = {
  todo: 'todo', working: 'working', waiting: 'blocked', ready_to_close: 'review', done: 'done',
};

export type WorkTask = {
  id: string;
  title: string;
  kind: TaskDetails['kind'];
  owner: TaskDetails['owner'];
  state: TaskState;
  doneWhen?: string;
  now?: string;
  source?: TaskDetails['source'];
  due?: TaskDue;
  parentTaskId?: string;
  workItemId?: string;
  decision?: TaskDetails['decision'];
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  canReopen?: true;
  needsYou?: true;
};

export function workTaskView(record: BackingTask, threadId: string): WorkTask {
  const work = getTaskDetails(record);
  const { state: postponed, openState, doneWhen, now, source, ...details } = work;
  const state = postponed ?? openState ?? states[record.state];
  const base = {
    ...details, id: record.id, title: record.title, state,
    ...(record.closedByUser && state === 'done' ? { canReopen: true as const } : {}),
    ...(record.asked && work.kind === 'decision' && work.owner.kind === 'user' && state !== 'done' && state !== 'postponed' ? { needsYou: true as const } : {}),
  };
  if (isLoop(record)) {
    return {
      ...base, createdAt: record.createdAt, updatedAt: record.updatedAt, closedAt: record.closedAt, doneWhen,
      now: now ?? record.summary, source: source ?? { threadId, seq: record.sourceSeq },
      ...(work.kind === 'decision' ? {
        decision: { options: record.options?.map((label) => ({ label })), ...work.decision },
      } : {}),
    };
  }
  const runUpdatedAt = record.run?.updatedAt;
  return {
    ...base, doneWhen: doneWhen ?? record.doneWhen, now: now ?? record.run?.summary,
    createdAt: record.createdAt,
    updatedAt: runUpdatedAt && runUpdatedAt > (record.updatedAt ?? '') ? runUpdatedAt : record.updatedAt,
    source: source ?? (record.run ? { threadId: record.run.helperThreadId, runId: record.run.id } : undefined),
  };
}

export function boardView(row: Coordinator) {
  const tasks = boardRecords(row).map((task) => workTaskView(task, row.threadId));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.parentTaskId) task.workItemId = byId.get(task.parentTaskId)?.workItemId;
  }
  const workItems = row.workItems.map((item) => {
    const members = tasks.filter((t) => !t.parentTaskId && t.workItemId === item.id);
    return { ...item, progress: { done: members.filter((t) => t.state === 'done').length, total: members.length } };
  });
  return { workItems, tasks };
}

const publicRunSchema = runSchema.omit({ brief: true, restart: true, restartResumes: true, crashResumes: true, updates: true, updateWithheld: true });
const publicDeskSchema = recordSchema.pick({
  projectId: true, threadId: true, state: true, charter: true, interests: true,
  updatedAt: true, wakeAt: true, selectedTaskId: true,
}).strip();
export function coordinatorView(row: Coordinator) {
  return structuredClone({
    ...publicDeskSchema.parse(row),
    tasks: row.tasks.map((task) => ({ ...legacyTaskSchema.parse(task), ...(task.run ? { run: publicRunSchema.parse(task.run) } : {}) })),
    questions: row.questions.map((q) => questionSchema.parse(q)),
    loops: row.loops.map((loop) => loopSchema.parse(loop)),
    taskBoard: boardView(row),
  });
}
export type CoordinatorView = ReturnType<typeof coordinatorView>;
