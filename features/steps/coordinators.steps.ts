import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

type Coordinator = {
  on: boolean;
  setup: string | null;
  thread: string | null;
  tab: string;
  state: string | null;
  tasks: { title: string; state: string }[] | null;
  taskDetailsBounds?: [number, number, number, number];
  taskBoard?: {
    workItems: { id: string; collapsed: boolean; done: number; total: number }[];
    tasks: { id: string; title: string; state: string }[];
  };
  loops: { id: string; kind: string; state: string; title: string }[] | null;
  openLoopsCount: number | null;
  agentMemoryOpen: boolean;
  undoLoop: { loopId: string; title: string } | null;
  documentShown: boolean;
  editing: { draft: string; reviewCurrent: string | null } | null;
  document: { state: string; notes: string } | null;
};
const coordinator = (d: unknown) => (d as { coordinator?: Coordinator }).coordinator;

Then('the coordinator experiment is {string}', async function (this: ThreadbearWorld, state: string) {
  await this.until(`coordinator experiment ${state}`, (d) => coordinator(d)?.on === (state === 'on'));
});

Then('the project hides its Add coordinator control', async function (this: ThreadbearWorld) {
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === "Add a coordinator that keeps this project's notes and work current"), false);
});

Then('the project offers its Add coordinator control', async function (this: ThreadbearWorld) {
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === "Add a coordinator that keeps this project's notes and work current"), true);
});

When('the coordinator setting is restored without a notification', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorExperiment', params: { on: true, notify: false } });
});

When("I open the project's Add coordinator dialog", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: "Add a coordinator that keeps this project's notes and work current" });
});

Then('the Add coordinator dialog is open', async function (this: ThreadbearWorld) {
  await this.until('the Add coordinator dialog to open', (d) => Boolean(coordinator(d)?.setup));
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === 'Keep the project as it is'), true);
  assert.equal(labels.some((control) => control.label === "Start this project's coordinator using the chosen pool and model"), true);
});

When('I press Escape to dismiss the Add coordinator dialog', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'menu-key', key: 'escape' });
});

When('I cancel the Add coordinator dialog', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Keep the project as it is' });
});

Then('the Add coordinator dialog is closed', async function (this: ThreadbearWorld) {
  await this.until('the Add coordinator dialog to close', (d) => coordinator(d)?.setup === null);
});

When("I add the project's coordinator", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: "Add a coordinator that keeps this project's notes and work current" });
  await this.app.do({ cmd: 'click', tip: "Start this project's coordinator using the chosen pool and model" });
});

When("I open the coordinator's {string} tab", async function (this: ThreadbearWorld, tab: string) {
  await this.app.do({ cmd: 'click', tip: `Show the project's ${tab.toLowerCase()}` });
});

// A coordinator is never archived, so a finished turn with no follow-ups
// leaves the box with no card at all (26 Nov).
Then('the coordinator shows no Done card', async function (this: ThreadbearWorld) {
  await this.until('the coordinator box without a card', (d) => !d.composer.card?.length);
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === 'Archive this thread'), false);
});

Then('the ordinary Done card has its Archive button', async function (this: ThreadbearWorld) {
  await this.until('the ordinary Done card', (d) => d.composer.card?.[0] === 'Done');
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === 'Archive this thread'), true);
});

Then("the coordinator's {string} tab is open", async function (this: ThreadbearWorld, tab: string) {
  await this.until(`the ${tab} coordinator tab`, (d) => Boolean(coordinator(d)?.thread) && coordinator(d)?.tab === tab);
});

Then('the coordinator is listed once in its own sidebar section', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  const id = coordinator(d)?.thread;
  assert.ok(id, 'the project coordinator is open');
  const sections = d.sidebar.sections.filter((s) => s.threads.some((t) => t.id === id));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'Coordinators');
});

Then("the coordinator's document contains {string}", async function (this: ThreadbearWorld, text: string) {
  await this.until(`shared project state containing ${text}`, (d) => coordinator(d)?.documentShown && coordinator(d)?.document?.state.includes(text));
});

Then('the coordinator has the to-do {string} in {string}', async function (this: ThreadbearWorld, title: string, state: string) {
  await this.until(`the ${title} to-do ${state}`, (d) => coordinator(d)?.tasks?.some((t) => t.title === title && t.state === state));
});

When('I pause the project coordinator', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Pause or resume the coordinator and its helpers' });
});

Then('the project coordinator is {string}', async function (this: ThreadbearWorld, state: string) {
  await this.until(`coordinator ${state}`, (d) => coordinator(d)?.state === state);
});

When('a coordinator helper finishes its work', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorFinish', params: {} });
});

When('the coordinator checks and accepts the helper result', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorVerify', params: {} });
});

async function scrollDocumentToBottom(world: ThreadbearWorld): Promise<void> {
  await world.until('the shared project document', (d) => Boolean(coordinator(d)?.documentShown));
  const size = /([\d.]+)x([\d.]+)/.exec(await world.app.do({ cmd: 'window' }));
  if (!size) throw new Error('The window did not give its size');
  await world.app.do({ cmd: 'point', x: Number(size[1]) - 100, y: Number(size[2]) / 2, scrollY: -2000 });
}

When('I edit the project notes and add {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until('agent memory open', (d) => Boolean(coordinator(d)?.documentShown && coordinator(d)?.agentMemoryOpen));
  await this.app.do({ cmd: 'click', tip: 'Edit the notes (or double-click it)' });
  await this.app.do({ cmd: 'type', here: true, text: `\n${text}` });
});

When('the coordinator changes the saved notes to {string}', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorNotesChanged', params: { text } });
});

When('I save the project text', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'menu-key', key: 'enter', modifiers: ['cmd'] });
});

Then('the project editor shows the current version {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until('the current saved text beside the draft', (d) => coordinator(d)?.editing?.reviewCurrent === text);
});

Then('the project editor still contains {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until('the preserved draft', (d) => coordinator(d)?.editing?.draft.includes(text));
});

When('I acknowledge the current project text', async function (this: ThreadbearWorld) {
  await scrollDocumentToBottom(this);
  await this.app.do({ cmd: 'click', tip: 'Keep my draft and compare its next save against this saved version' });
});

When('I append {string} to the project draft', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'type', here: true, text: `\n${text}` });
});

Then('the project notes contain {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until('the merged saved notes', (d) => coordinator(d)?.documentShown && coordinator(d)?.document?.notes.includes(text));
});

Then('the project editor is closed', async function (this: ThreadbearWorld) {
  await this.until('the editor closed after saving', (d) => Boolean(coordinator(d)) && coordinator(d)?.editing === null);
});

Then('agent memory is collapsed', async function (this: ThreadbearWorld) {
  await this.until('agent memory collapsed', (d) => Boolean(coordinator(d)?.documentShown) && coordinator(d)?.agentMemoryOpen === false);
});

Then('agent memory is open', async function (this: ThreadbearWorld) {
  await this.until('agent memory open', (d) => Boolean(coordinator(d)?.documentShown) && coordinator(d)?.agentMemoryOpen === true);
});

When('I open agent memory', async function (this: ThreadbearWorld) {
  await this.until('the shared project document', (d) => Boolean(coordinator(d)?.documentShown));
  await this.app.do({ cmd: 'click', tip: 'Show agent memory notes' });
});

When('I close agent memory', async function (this: ThreadbearWorld) {
  await this.until('agent memory open', (d) => Boolean(coordinator(d)?.agentMemoryOpen));
  await this.app.do({ cmd: 'click', tip: 'Hide agent memory notes' });
});

Then('the coordinator has {int} open loops', async function (this: ThreadbearWorld, count: number) {
  await this.until(`${count} open loops`, (d) => coordinator(d)?.openLoopsCount === count);
});

When('I close the answered open loop', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Mark this question answered and close it' });
});

Then('the undo banner is shown for the closed loop', async function (this: ThreadbearWorld) {
  await this.until('undo banner shown', (d) => Boolean(coordinator(d)?.undoLoop));
});

When('I undo closing the open loop', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Reopen this closed loop' });
});

When('the coordinator asks me a decision', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorAsk', params: {} });
});

When("the coordinator receives its helper's report", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorAsk', params: { carry: true } });
  await this.until('the report being read', (d) => d.transcript.rows.some((r) => r.text?.includes('A helper checked the project brief.')));
});

Then('Open loops shows the decision without answer buttons', async function (this: ThreadbearWorld) {
  await this.until('the decision mirrored in Open loops', (d) => coordinator(d)?.openLoopsCount === 3);
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === 'Answer this on the Needs you card'), true);
  for (const gone of ['Reply "Collapse by default" and close this loop', 'Pick "Collapse by default", then add anything else and send', 'Write your reply to this decision', 'Close this decision without replying']) {
    assert.equal(labels.some((control) => control.label === gone), false, `${gone} should be on the Needs you card only`);
  }
});

When('I click the decision in Open loops', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Answer this on the Needs you card' });
});


When('the coordinator publishes a task board', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorTaskBoard', params: {} });
  await this.until('canonical task board', (d) => Boolean(coordinator(d)?.taskBoard?.tasks.length));
});

Then('Highlights has no task action buttons', async function (this: ThreadbearWorld) {
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  for (const forbidden of ['Done', 'Got it, close', 'Undo', 'Not now', 'Send choice']) {
    assert.equal(
      labels.some((control) => control.label === forbidden),
      false,
      `Highlights should be read-only and not render ${forbidden}`,
    );
  }
});

When('I open {string} from Highlights', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'click', tip: `Open ${title} in Tasks` });
});

When('I switch task grouping', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Switch between grouping by status and by work item' });
});

When('I close the task details', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Close task details' });
});

When('I press the task button {string}', async function (this: ThreadbearWorld, title: string) {
  // On the Tasks tab the same action can be visible in Highlights too.
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string; x: number; y: number }[];
  const button = labels.filter((control) => control.label === title).sort((a, b) => a.x - b.x)[0];
  assert.ok(button, `No visible task button for ${title}`);
  await this.app.do({ cmd: 'click-at', x: button.x, y: button.y });
});

When('I collapse the {string} work item', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'click', tip: `Collapse ${title}` });
});

When('I expand the {string} work item', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'click', tip: `Expand ${title}` });
  await this.until('Getting there expanded', (d) => coordinator(d)?.taskBoard?.workItems.some((i) => !i.collapsed));
});

When('I select the task {string}', async function (this: ThreadbearWorld, title: string) {
  const label = `Show task ${title}`;
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  const row = labels.find((control) => control.label === label || control.label.startsWith(`${label} ·`));
  assert.ok(row, `No visible task row for ${title}`);
  await this.app.do({ cmd: 'click', tip: row.label });
});

Then('the task {string} is {string}', async function (this: ThreadbearWorld, id: string, state: string) {
  await this.until(`task ${id} in ${state}`, (d) => coordinator(d)?.taskBoard?.tasks.some((t) => t.id === id && t.state === state));
});

Then('the task board saves {string} collapsed with {int} of {int} done', async function (this: ThreadbearWorld, id: string, done: number, total: number) {
  await this.until(`collapsed group ${id}`, (d) => coordinator(d)?.taskBoard?.workItems.some((i) => i.id === id && i.collapsed && i.done === done && i.total === total));
});

Then('Highlights has no link to {string}', async function (this: ThreadbearWorld, title: string) {
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === `Open ${title} in Tasks`), false);
});


Then('the Conversation decision card is open', async function (this: ThreadbearWorld) {
  await this.until('an open Conversation decision card', (d) => d.composer.card?.[0] === 'Needs you');
});

Then('the Conversation decision card is gone', async function (this: ThreadbearWorld) {
  await this.until('Conversation cleared the resolved decision card', (d) => !d.composer.card?.length);
});

When('I scroll the Tasks details down', async function (this: ThreadbearWorld) {
  const bounds = coordinator(await this.app.dump())?.taskDetailsBounds;
  assert.ok(bounds, 'The Tasks details must be drawn');
  const [left, top, right, bottom] = bounds;
  assert.ok(bottom > top && right > left, 'The details pane has visible space');
  await this.app.do({ cmd: 'point', x: (left + right) / 2, y: (top + bottom) / 2, scrollY: -2000 });
});

Then('the Tasks details show {string}', async function (this: ThreadbearWorld, label: string) {
  const bounds = coordinator(await this.app.dump())?.taskDetailsBounds;
  assert.ok(bounds, 'The Tasks details must be drawn');
  const [left, top, right, bottom] = bounds;
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string; x: number; y: number }[];
  assert.ok(labels.some((control) => control.label === label && control.x >= left && control.x < right && control.y >= top && control.y < bottom), `No visible Tasks details control ${label}`);
});
