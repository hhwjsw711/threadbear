---
id: mailWatch
name: Email watcher
title: Email watcher: new emails wake the threads waiting on them, reach the threads they're about, or wait on a twice-daily list
added: 2026-11-20
on: false
reminder: b7392f80
---

## What it does

Every few minutes the runner runs a command of yours that prints your new emails, and a small model sorts them against your threads. An email a hibernating thread was waiting on (a reply, an approval, a delivery) wakes that thread with the email, and its agent checks it really is what it waited for. An email about an open thread's work is kept for that thread: a note in it says so, and its agent reads the email on the thread's next turn, without one being started for it. When one of your standing decisions (files you name, such as a memory index) clearly says what to do with an email, and a stronger model agrees, it's done straight away in the thread it belongs to or a new one, which archives itself when finished; at most four a day, and never sending, posting, paying or deleting unless the decision says exactly that. Anything else that looks like it needs you goes on a list, which comes as one thread at 9 am and 4 pm (or the times you set), with a suggested action for each and what was done without asking since the last one. Where an email only says something needs you and not what (an order on hold, say), the list's agent finds out on that service's own site first, so its question says what's wrong. Newsletters, receipts, CI build alerts and other automated notifications are left alone. Only the main Mac's runner looks.

It needs `mailWatch` in runner.json: `command` (prints a JSON list of emails, each with `id`, `from`, `subject` and the start of its `text`, and optionally `account`, `date`, `url` and `threadId`; it gets `THREADBEAR_MAIL_STATE`, a file it may keep its place in), and optionally `everyMinutes` (5), `digestAt` (`["09:00", "16:00"]`), `folder` (where new threads start; your home folder), `decisions` (files of standing decisions; none means it never acts) and `act: false` to never act. The runner holds no mail login: the command reads the mail. The sender, subject and first 1,500 characters of each new email go to the model, with your recent threads' titles and briefs (never a private folder's).

## Lives in

`runner/src/mail-watch.ts` (the looks, the sorting, the pile and its list), `runner/src/runner/mail.ts` (which threads, waking one, keeping an email for one), the `takeHeldMail` call in `deliver` in `runner/src/runner.ts`, `heldMail` in `runner/src/store.ts`, `mailWatch` in `RunnerJson` (`runner/src/config.ts`) and its construction in `runner/src/main.ts`. It keeps `runner/mail-watch.json` in the data dir.

## Taking it out

Delete `mail-watch.ts`, `runner/mail.ts` and their test, `mailPart` and `MailPart` in `runner.ts` with the `takeHeldMail` lines in `deliver`, `heldMail` and `HeldMail` in `store.ts` (and its entry in `OBJECT_LISTS`), `mailWatch` in `config.ts`, and the `MailWatch` block and its `stop` in `main.ts`.
