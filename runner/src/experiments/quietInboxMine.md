---
id: quietInboxMine
name: Quiet inbox for your threads
title: Quiet inbox for your threads: your own finished threads that a model says you didn't need to see go straight to Archived
added: 2026-11-23
on: false
reminder: 994605b5
---

## What it does

Part of the quiet inbox. Threads another thread started already archive themselves when they finish with nothing for you; this does the same for your own threads, when a model is confident you didn't need to read the reply. It needs Inbox guess on too, as the guess comes from there: when one of your threads finishes with nothing for you and nothing left open, the strong model (Opus, or Codex when the pool's Claude logins are out of room) guesses whether you needed to see it. If it says no, the thread is archived with a line in it saying why. A thread with follow-ups, anything left open, a star, one you've already looked at, one you once brought back out of the archive, or a reminder you set yourself (a thread an X bookmark started) is never archived this way, and nothing happens if Opus couldn't answer.

To check what it hid, a daily thread (a schedule of Mike's, while the experiment runs) lists the threads it archived the day before, with the model's reason for each. Tell it which you should have seen: it brings them back with `tb unarchive <id> --wrong-hide`, which writes the miss down so the guess can be scored. Or right-click an archived thread and pick Should Have Shown Me, which does the same. (A "Quietly archived: N today" line at the foot of the Inbox did this for a day; Mike didn't want it cluttering the sidebar.) The decisions and your corrections are in `inbox-guess.jsonl` in the runner's data folder, with a `revive` line each time you write to a thread that's archived or hibernating (not an agent's or a schedule's message): who put it away (the quiet inbox, you, an agent or Threadbear), when and why, and the start of what you wrote, so the review sees the threads you wanted back without saying so. Threads on another runner aren't part of it yet.

## Lives in

`quietArchive` in `runner/src/runner/inbox-guess.ts` (called from `guessInbox`), and `noteRevive` there (called from `sendTo` in `runner.ts`); `quietlyArchived` on the thread record (`store.ts`, cleared in `parkRecord` in `place.ts`) and on its summary (`runner.ts` summary, `protocol.ts`); the `shouldHaveShown` verdict on an unarchive (`runner.ts` update, `rpc.ts`); `tb unarchive --wrong-hide` (`runner/src/cli.ts`); in the desktop app `desktop/gpui/src/quiet_inbox.rs` and `MenuAction::ShouldHaveShown` in `desktop/gpui/src/sidebar.rs`

## Taking it out

Delete `quietArchive` and its call in `guessInbox`, `noteRevive` and its call in `sendTo`, `quietlyArchived` on the record and the summary and its clearing in `parkRecord`, the `shouldHaveShown` verdict and its `wrongHide` line, `tb unarchive --wrong-hide`, the daily review schedule, and in the desktop app `quiet_inbox.rs` and `MenuAction::ShouldHaveShown`. Threads it archived stay archived, as by Threadbear.
