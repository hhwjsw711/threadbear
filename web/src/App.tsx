// Mike's own threads, signed in: the Mac app's window in a browser. The
// sidebar (sidebar.tsx) beside a thread with each finished turn folded to
// "Worked for 4m 12s" and its reply, and the agent's card of asks joined to
// the composer. A shared thread (/s/<slug>) is share.tsx.
import { Component, Fragment, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation } from 'convex/react';
import { useLiveQuery } from './live';
import { InboxProvider, useInbox } from './inbox';
import { useTranscript } from './transcript';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import { go, threadPath, useRoute } from './route';
import { stillWorking } from './sections';
import { useSignInNote, useSigningIn, useToken } from './token';
import { EditedDrafts, MessageText, Pictures, PlanCard, picturesByRow, ToolRun, Worked, type PageMessage } from './messages';
import { splitEdited } from './draft';
import { ReplyButton } from './reply-button';
import { OutLink } from './link-confirm';
import { CommandNote, useCommand } from './command-state';
import { STOP_HOLD_MS, unqueued } from './command';
import { holdStop, releaseStop, stopHeldFor } from './stop-hold';
import { withFailed, withoutSent } from './composer-draft';
import { isPaged, nextUnanswered } from './ask-pager';
import { previewOf, ShareControl, SharePage } from './share';
import { busy, Lists, ResizeHandle, type Row, useSidebarWidth } from './sidebar';
import { Pop } from './menu';
import { pastedOf } from './picture-chips';
import { Rail } from './rail';
// Loaded only when it's opened: the viewer's diagrams are most of its size.
const MachinesPage = lazy(() => import('./machines'));
// The design review board, loaded when one is opened.
const ThreadReviews = lazy(() => import('./review-board'));
import { OpenReview } from './review-open';
import { NewThread, ProjectPage, ProjectsList, RunnerPage, RunnersList, ScheduledList, SchedulePage, UsageList, UsagePage } from './pages';
import { duration, fold, gapLabel, isNote, splitTurns, type Item } from './turns';
import { folderName, sender } from './format';
import * as Icon from './icons';
import { ReviewRow } from './review-row';
import { reviewSeq, type LabReviewLedger } from './lab-review';

type Approval = NonNullable<Row['pendingApproval']>;
type Ask = NonNullable<Row['asks']>[number];

export function App() {
  const token = useToken();
  const route = useRoute();
  // A shared thread is for anyone, signed in or not.
  if (route.page === 'share') return <SharePage key={route.slug} slug={route.slug} token={token} />;
  if (!token) return <SignIn />;
  // The backend's state machines: a page of its own, the viewer filling it.
  if (route.page === 'machines')
    return (
      <Catch key={token}>
        <Suspense fallback={<main className="signin"><p>Loading the machines…</p></main>}>
          <MachinesPage token={token} />
        </Suspense>
      </Catch>
    );
  // Keyed on the token so a fresh sign-in clears an earlier auth error.
  return (
    <Catch key={token}>
      <InboxProvider token={token}>
        <Shell token={token} route={route} />
      </InboxProvider>
    </Catch>
  );
}

// ------------------------------------------------------------ sign-in

function SignIn({ expired }: { expired?: boolean }) {
  const signingIn = useSigningIn();
  const note = useSignInNote();
  if (signingIn) {
    return (
      <main className="signin">
        <img src="/icon.png" alt="" width={72} height={72} />
        <h1>Threadbear</h1>
        <p>Signing in…</p>
      </main>
    );
  }
  return (
    <main className="signin">
      <img src="/icon.png" alt="" width={72} height={72} />
      <h1>Threadbear</h1>
      {note ? <p>{note}</p> : null}
      <p>{expired ? 'This browser’s sign-in has expired or been revoked.' : 'This browser isn’t signed in yet.'}</p>
      <p>On the Mac, open Threadbear, then Settings › Phone &amp; browser › Open signed in.</p>
      <p className="muted small">
        It opens this site in your browser, signed in. From a terminal instead, in the repo: <code>npm run web:sign-in</code> (add <code>-- --qr</code> for a code to scan on another device).
      </p>
    </main>
  );
}

// Auth and missing-thread errors from Convex land here rather than as a
// blank page.
class Catch extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const kind = error instanceof ConvexError ? (error.data as { kind?: string })?.kind : undefined;
    if (kind === 'auth') return <SignIn expired />;
    return (
      <main className="signin">
        <h1>{kind === 'notFound' ? 'No such thread' : 'Something went wrong'}</h1>
        <p className="muted">{kind === 'notFound' ? 'It may have been deleted, or the Mac hasn’t mirrored it yet.' : String(error)}</p>
        <p>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              this.setState({ error: null });
              go('/');
            }}
          >
            Back to the threads
          </a>
        </p>
      </main>
    );
  }
}

// ------------------------------------------------------------ layout

function Shell({ token, route }: { token: string; route: ReturnType<typeof useRoute> }) {
  const selected = route.page === 'thread' ? route.threadId : undefined;
  const id = route.page === 'scheduled' || route.page === 'projects' || route.page === 'runners' || route.page === 'usage' ? route.id : undefined;
  const [width, setWidth] = useSidebarWidth();
  const shell = useRef<HTMLDivElement>(null);
  // On a phone there's one column: a list, or what's open from it.
  const open = !!selected || !!id || route.page === 'new';
  return (
    <div ref={shell} className={`shell ${open ? 'has-thread' : ''}`} style={{ '--sidebar-width': `${width}px` } as CSSProperties}>
      <Rail token={token} route={route} />
      <aside className="sidebar">
        {route.page === 'scheduled' ? (
          <ScheduledList token={token} selected={id} />
        ) : route.page === 'projects' ? (
          <ProjectsList token={token} selected={route.page === 'projects' && id && route.runnerId ? { runnerId: route.runnerId, id } : undefined} />
        ) : route.page === 'runners' ? (
          <RunnersList token={token} selected={id} />
        ) : route.page === 'usage' ? (
          <UsageList token={token} selected={id} />
        ) : (
          <Lists token={token} selected={selected} isNew={route.page === 'new'} />
        )}
        <ResizeHandle shell={shell} width={width} setWidth={setWidth} />
      </aside>
      <main className="main">
        {selected ? (
          <ThreadView key={selected} token={token} threadId={selected} />
        ) : route.page === 'new' ? (
          <NewThread token={token} />
        ) : route.page === 'scheduled' && id ? (
          <SchedulePage key={id} token={token} id={id} />
        ) : route.page === 'projects' && id ? (
          <ProjectPage key={`${route.runnerId ?? ''}/${id}`} token={token} runnerId={route.runnerId} id={id} />
        ) : route.page === 'runners' && id ? (
          <RunnerPage key={id} token={token} id={id} />
        ) : route.page === 'usage' && id ? (
          <UsagePage key={id} token={token} id={id} />
        ) : (
          <Empty text={route.page === 'scheduled' ? 'Pick a schedule.' : route.page === 'projects' ? 'Pick a project.' : route.page === 'runners' ? 'Pick a runner.' : route.page === 'usage' ? 'Pick a login.' : 'Pick a thread.'} />
        )}
      </main>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <img src="/icon.png" alt="" width={88} height={88} />
      <p>{text}</p>
    </div>
  );
}

// ------------------------------------------------------------ thread

function ThreadView({ token, threadId }: { token: string; threadId: string }) {
  const t = useLiveQuery(api.phone.threadRow, { token, threadId });
  const shown = useTranscript(token, threadId);
  // For thread: links, as agents may give only the start of an id.
  const inbox = useInbox();
  const update = useMutation(api.phone.update);
  // The ... menu's Star, Hibernate, Wake, Archive and Bring back, and the
  // done card's Archive: one at a time, each said under the thread.
  const change = useCommand(token);
  const bottom = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const keepFromBottom = useRef<number | null>(null);
  const seen = useRef(false);
  // The design review board over the page: a review's id, '' for the pending list.
  const [reviewShown, setReviewShown] = useState<string>();
  const lastSeq = shown?.messages.at(-1)?.seq;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastSeq, t?.status]);
  // After loading earlier messages, stay where you were rather than jumping.
  useEffect(() => {
    const el = list.current;
    if (!el || keepFromBottom.current === null) return;
    el.scrollTop = el.scrollHeight - keepFromBottom.current;
    keepFromBottom.current = null;
  }, [shown?.messages.length]);

  // Opening a thread here counts as reading it, like opening it on the Mac.
  useEffect(() => {
    if (!t || seen.current) return;
    seen.current = true;
    if (t.unread || t.needsYou) void update({ token, threadId, change: { markSeen: true } });
  }, [t, token, threadId, update]);

  useEffect(() => {
    if (t) document.title = `${t.title || 'Untitled'} · Threadbear`;
    return () => {
      document.title = 'Threadbear';
    };
  }, [t?.title]);

  const rows = (shown?.messages ?? []) as PageMessage[];
  const items = useMemo(() => fold(rows, t ? busy(t) : false), [rows, t?.status]);
  // Without the login notes, which only the fold places: everything else
  // here (links to steps, pictures, the review's place) is about what Mike
  // and the agent said and did.
  const messages = useMemo(() => rows.filter((m) => !isNote(m)), [rows]);
  if (!shown || !t) return <div className="pad muted">Loading…</div>;

  // A live page (API 95) runs only in the Mac and iPhone apps' sealed views:
  // here it's its title, never an <img> or a link to its file.
  const pictures = (shown.images ?? []).filter((p) => (p as { mediaType?: string }).mediaType !== 'text/html');
  const inText = new Map(pictures.filter((p) => p.src).map((p) => [p.src!, p.url]));
  const after = picturesByRow(messages, pictures);
  const linkTo = (id: string) => threadPath(inbox?.find((r) => r.threadId.startsWith(id))?.threadId ?? id);
  const act = (c: Parameters<typeof update>[0]['change']) => void change.run(() => update({ token, threadId, change: c }), undefined);
  // Another lab's review goes over its turn's reply, as on the Mac (backend API 76).
  const review = t.review as LabReviewLedger | undefined;
  const reviewAt = review ? reviewSeq(messages, t.cardTurn) : undefined;

  // The meta line under the last reply: how long its turn took and what the
  // thread has cost, as on the Mac.
  const lastTurn = splitTurns(messages).at(-1);
  const lastReply = [...items].reverse().find((i) => i.kind === 'message');
  const meta = !busy(t) && lastReply?.kind === 'message' && lastReply.m.role === 'assistant' ? [lastTurn?.ms && lastTurn.ms >= 1000 ? duration(lastTurn.ms) : null, t.costUsd ? `$${t.costUsd.toFixed(2)}` : null].filter(Boolean).join(' · ') : '';

  // A reply's [title](button:<id>) links, drawn from the row's buttons. An id
  // the row doesn't carry (an older runner, a button the thread no longer
  // keeps) is just its title.
  const buttonFor = (m: PageMessage) => (id: string, title: ReactNode) => {
    const b = m.buttons?.find((x) => x.id === id);
    return b ? <ReplyButton key={id} token={token} threadId={threadId} button={b} title={title} threadPath={linkTo} /> : <>{title}</>;
  };

  const renderItem = (item: Item<PageMessage>): ReactNode => {
    if (item.kind === 'worked') {
      return (
        <Worked key={`w${item.key}`} ms={item.ms}>
          {item.items.map((w) => (w.kind === 'tools' ? <ToolRun key={w.items[0]!.seq} items={w.items} open source={{ token, threadId }} /> : renderItem(w)))}
        </Worked>
      );
    }
    if (item.kind === 'tools') {
      return (
        <div key={item.items[0]!.seq}>
          <ToolRun items={item.items} source={{ token, threadId }} />
          <Pictures items={item.items.flatMap((m) => after.get(m.seq) ?? [])} />
        </div>
      );
    }
    if (item.kind === 'gap') {
      // "5 min later · Codex answered": the wait before a turn the agent woke
      // up for, or the runner's own message started, as the Mac draws it.
      return (
        <div key={`g${item.gap.seq}`} className="turn-gap">
          <span>{gapLabel(item.gap)}</span>
        </div>
      );
    }
    const m = item.m;
    if (item.kind === 'note') {
      return (
        <div key={m.seq} className="login-note">
          {m.text}
        </div>
      );
    }
    const from = sender(m);
    // Drafts he changed, sent on the end of his words: chips, not the raw fences.
    const edited = !from && m.role === 'user' ? splitEdited(m.text) : undefined;
    const shownText = edited ? edited.words : m.text;
    return (
      <Fragment key={m.seq}>
      {m.seq === reviewAt && review ? <ReviewRow review={review} threadPath={linkTo} /> : null}
      <div className={`msg ${m.role}`}>
        {from ? <div className="origin">{from.who}</div> : m.role === 'user' && m.origin && m.origin !== 'user' && m.origin !== 'phone' ? <div className="origin">{originLabel(m.origin)}</div> : null}
        {m.plan && m.role === 'assistant' ? <PlanCard m={m} pictures={inText} rows={messages} threadPath={linkTo} button={buttonFor(m)} /> : from ? <MessageText text={from.body} pictures={inText} seq={m.seq} rows={messages} threadPath={linkTo} /> : edited && !shownText.trim() ? null : <MessageText text={shownText} pictures={inText} seq={m.seq} rows={messages} threadPath={linkTo} pictureChips={m.role === 'user'} pasted={m.role === 'user' ? pastedOf(pictures, m.seq, shownText).byNumber : undefined} button={m.role === 'assistant' ? buttonFor(m) : undefined} />}
        {edited ? <EditedDrafts drafts={edited.drafts} /> : null}
        <Pictures items={[...(after.get(m.seq) ?? []), ...(m.role === 'user' ? pastedOf(pictures, m.seq, shownText).unplaced : [])]} />
      </div>
      </Fragment>
    );
  };

  return (
    <OpenReview.Provider value={setReviewShown}>
    <article className="thread">
      <header className="thread-head">
        <button className="icon-btn back" onClick={() => go('/')} aria-label="Back to the threads" title="Back to the threads">
          <Icon.Back />
        </button>
        <div className="crumbs" title={t.cwd}>
          <span className="folder">{folderName(t.cwd)}</span>
          <span className="sep">/</span>
          <h1>{t.title || 'Untitled'}</h1>
        </div>
        {(t.pendingReviews ?? 0) > 0 ? (
          <button className="btn plain reviews-btn" onClick={() => setReviewShown('')} title="Read the pending design reviews and answer">
            <Icon.Boards />
            Reviews
          </button>
        ) : null}
        <ShareControl token={token} threadId={threadId} share={t.share} preview={previewOf(t.title, messages, pictures.filter((p) => !p.src?.startsWith('picture:')))} />
        <MoreMenu
          items={[
            { label: 'Copy link', icon: <Icon.Link />, run: () => void navigator.clipboard.writeText(location.origin + location.pathname) },
            { label: t.starredAt ? 'Unstar' : 'Star', icon: t.starredAt ? <Icon.StarOff /> : <Icon.Star />, run: () => act({ star: !t.starredAt }), busy: change.busy },
            t.view === 'hibernating' || t.snoozedUntil ? { label: 'Wake', icon: <Icon.Sun />, run: () => act({ wake: true }), busy: change.busy } : t.view === 'inbox' ? { label: 'Hibernate', icon: <Icon.Moon />, run: () => act({ snooze: { untilRestart: true } }), busy: change.busy } : null,
            t.view === 'den' ? { label: 'Bring back', icon: <Icon.Inbox />, run: () => act({ unarchive: true }), busy: change.busy } : { label: 'Archive', icon: <Icon.Archive />, run: () => act({ archive: true }), busy: change.busy },
          ]}
        />
      </header>

      <div className="messages" ref={list}>
        {shown.hasMore ? (
          <button
            className="btn earlier"
            disabled={shown.loadingMore}
            onClick={() => {
              const el = list.current;
              keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
              shown.loadMore();
            }}
          >
            {shown.loadingMore ? 'Loading…' : 'Load earlier messages'}
          </button>
        ) : null}
        {items.map(renderItem)}
        {meta ? <div className="meta">{meta}</div> : null}
        {busy(t) ? (
          <div className="working">
            <span className="spinner" /> {t.working || 'Working…'}
          </div>
        ) : t.status === 'error' ? (
          <div className="failed-note">The last turn failed. Send a message to try again.</div>
        ) : null}
        <div ref={bottom} />
      </div>

      <div className="dock">
        <CommandNote command={change} sending />
        <Dock token={token} thread={t} lastSeq={lastSeq} onArchive={() => act({ archive: true })} archiving={change.busy} linkTo={linkTo} />
      </div>
      {reviewShown !== undefined ? (
        <Suspense fallback={<div className="rb"><div className="rb-wait center"><span className="spinner" /></div></div>}>
          <ThreadReviews token={token} threadId={threadId} reviewId={reviewShown} onClose={() => setReviewShown(undefined)} />
        </Suspense>
      ) : null}
    </article>
    </OpenReview.Provider>
  );
}

// busy: the item sends a command and one is still on its way.
function MoreMenu({ items }: { items: ({ label: string; icon: ReactNode; run: () => void; busy?: boolean } | null)[] }) {
  return (
    <Pop title="More" icon={<Icon.More />}>
      {(close) =>
        items.map((i) =>
          i ? (
            <button
              key={i.label}
              disabled={i.busy}
              onClick={() => {
                i.run();
                close();
              }}
            >
              {i.icon}
              {i.label}
            </button>
          ) : null,
        )
      }
    </Pop>
  );
}

// ------------------------------------------------------------ the dock

// What sits at the bottom, in one rounded box as on the Mac: an approval or
// question the CLI is waiting on, else the end_turn card of asks, else the
// done card's follow-ups, then the composer under it.
// "Fri 13 Nov, 9:30 am", for when a booked check-in comes back.
function bookedWhen(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// What the composer sent, to put back if it fails.
type Draft = { text: string; picks: { card?: number; by: Record<number, number> }; ticked: { seq?: number; set: Set<number> } };

function Dock({ token, thread: t, lastSeq, onArchive, archiving, linkTo }: { token: string; thread: Row; lastSeq?: number; onArchive: () => void; archiving: boolean; linkTo: (id: string) => string }) {
  const send = useMutation(api.phone.send);
  const interrupt = useMutation(api.phone.interrupt);
  const openReview = useContext(OpenReview);
  const [text, setText] = useState('');
  // Stop pressed: a spinner in its place, taking no more clicks, until the
  // turn is over (or STOP_HOLD_MS after its runner said done, as the iPhone
  // lets go), or a note saying why it couldn't. The runner says done as soon
  // as it has asked the CLI to stop, and the turn can run on for seconds
  // after: settling then showed Stop again while it ran, and a second press
  // sent a second interrupt.
  const stopCmd = useCommand(token, { settleMs: STOP_HOLD_MS });
  const threadId = t.threadId;
  const stop = () => {
    holdStop(threadId, Date.now());
    void stopCmd.run(() => interrupt({ token, threadId }), undefined);
  };
  // A Stop pressed before this page was made (Mike opened another thread and
  // came back) still holds, for what's left of it (stop-hold.ts).
  const [carried, setCarried] = useState(() => stopHeldFor(threadId, Date.now()));
  useEffect(() => {
    if (!carried) return;
    const timer = setTimeout(() => setCarried(0), carried);
    return () => clearTimeout(timer);
  }, [carried]);
  const stopDone = stopCmd.state.kind === 'done';
  useEffect(() => {
    if (stopDone) holdStop(threadId, Date.now());
  }, [stopDone, threadId]);
  // Over once the turn has ended, not while it waits on a card: the runner's
  // interrupt takes the card away and the same turn runs on (Codex's review).
  const turnOn = busy(t) || t.status === 'waiting';
  const stopOver = stopCmd.over;
  useEffect(() => {
    if (turnOn) return;
    stopOver();
    releaseStop(threadId);
    setCarried(0);
  }, [turnOn, stopOver, threadId]);
  const stopping = stopCmd.spinning || stopDone || (carried > 0 && stopCmd.state.kind === 'idle');
  const stopLocked = stopCmd.busy || (carried > 0 && stopCmd.state.kind === 'idle');
  // Picks on the card of asks: ask index to choice index, for one card.
  const [picks, setPicks] = useState<Draft['picks']>({ by: {} });
  const [pager, setPager] = useState<{ threadId?: string; card?: number; page: number }>({ page: 0 });
  const pageTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pageTimerRef.current), [t.threadId, t.asksSeq]);
  // After a pick pages on by itself, focus goes to the new ask's first choice,
  // so a keyboard or screen reader isn't left on a button that's gone.
  const asksRef = useRef<HTMLElement>(null);
  const focusPageRef = useRef(false);
  const [ticked, setTicked] = useState<Draft['ticked']>({ set: new Set() });
  // The composer keeps what's typed and picked until the backend has the
  // message, and gets it back if it fails later: its words above whatever
  // is there now (composer-draft.ts), its picks and ticks only where there
  // are none, so two drafts' picks never mix.
  const sending = useCommand<Draft>(token, {
    onQueued: (d) => {
      setText((cur) => withoutSent(cur, d.text));
      setPicks((cur) => (cur === d.picks ? { by: {} } : cur));
      setTicked((cur) => (cur === d.ticked ? { set: new Set() } : cur));
    },
    onFailed: (_error, d, queued) => {
      // Never queued: it was never taken out of the composer.
      if (!queued) return;
      setText((cur) => withFailed(cur, d.text));
      setPicks((cur) => (Object.values(cur.by).some((n) => n >= 0) ? cur : d.picks));
      setTicked((cur) => (cur.set.size ? cur : d.ticked));
    },
  });
  const holding = unqueued(sending.state);
  const asks = !busy(t) && !t.pendingApproval ? (t.asks ?? []) : [];
  const by = picks.card === t.asksSeq ? picks.by : {};
  const paged = isPaged(asks);
  const sameCard = pager.threadId === t.threadId && pager.card === t.asksSeq;
  const page = Math.min(sameCard ? pager.page : 0, Math.max(0, asks.length - 1));
  const pickAsk = (index: number, choice: number) => {
    clearTimeout(pageTimerRef.current);
    const nextBy = { ...by, [index]: by[index] === choice ? -1 : choice };
    setPicks({ card: t.asksSeq, by: nextBy });
    if (!paged || nextBy[index]! < 0) return;
    const to = nextUnanswered(index, asks.length, nextBy, false);
    if (to === null) return;
    const threadKey = t.threadId;
    const card = t.asksSeq;
    pageTimerRef.current = setTimeout(
      () =>
        setPager((cur) => {
          if ((cur.threadId === threadKey && cur.card === card ? cur.page : 0) !== page) return cur;
          focusPageRef.current = true;
          return { threadId: threadKey, card, page: to };
        }),
      300,
    );
  };
  useEffect(() => {
    if (!focusPageRef.current) return;
    focusPageRef.current = false;
    asksRef.current?.querySelector<HTMLElement>('.choices button')?.focus();
  }, [page]);
  const goPage = (p: number) => {
    clearTimeout(pageTimerRef.current);
    setPager({ threadId: t.threadId, card: t.asksSeq, page: p });
  };
  // Waiting on its own work isn't done, as on the Mac (19 Nov: a thread
  // waiting for CI before it could land said Done and was archived).
  const finished = !busy(t) && !t.needsYou && !t.pendingApproval && !asks.length && !t.archivedAt && !t.working && !stillWorking(t);
  const next = finished ? (t.next ?? []) : [];
  // What the runner found still open (docs/protocol/threads.md, "Loose ends"), as
  // on the Mac and the phone: open ones first, then booked check-ins.
  const ends = finished ? [...(t.looseEnds ?? []).filter((e) => e.kind !== 'scheduled'), ...(t.looseEnds ?? []).filter((e) => e.kind === 'scheduled')] : [];
  const follow = ticked.seq === lastSeq ? [...ticked.set].sort().map((i) => next[i]).filter((x): x is string => !!x) : [];

  const submit = async () => {
    const answers = asks.flatMap((a, i) => (by[i] !== undefined && choices(a)[by[i]!] !== undefined ? [{ index: i, action: a.action, answer: choices(a)[by[i]!]! }] : []));
    const extra = text.trim();
    const body = follow.length ? followUpMessage(follow, extra) : answers.length ? answerMessage(asks.length, answers, extra) : extra;
    if (!body) return;
    await sending.run(() => send({ token, threadId: t.threadId, text: body, ...(answers.length ? { answers: answers.map(({ action, answer }) => ({ action, answer })) } : {}) }), { text, picks, ticked }, { again: true });
  };

  const card = t.pendingApproval ? (
    <ApprovalCard key={t.pendingApproval.approvalId} token={token} threadId={t.threadId} approval={t.pendingApproval} />
  ) : asks.length ? (
    <section className="card" ref={asksRef}>
      <h2>
        ✋ {asks.length === 1 ? 'Decision needed' : 'Decisions needed'}
        {paged ? (
          <span className="pager">
            <button type="button" className="btn plain" disabled={page === 0} onClick={() => goPage(page - 1)} aria-label="Previous ask" title="Previous ask">
              ‹
            </button>
            <span className="of" aria-live="polite">
              {page + 1} of {asks.length}
            </span>
            <button type="button" className="btn plain" disabled={page === asks.length - 1} onClick={() => goPage(page + 1)} aria-label="Next ask" title="Next ask">
              ›
            </button>
          </span>
        ) : null}
      </h2>
      {asks.map((a, i) => (paged && i !== page ? null : (
        <Fragment key={i}>
          <div className="ask-q">
            <MessageText text={`${asks.length > 1 ? `${i + 1}. ` : ''}${a.action.replace(/\s*\n\s*/g, ' ').trim()}`} />
            {a.why?.trim() ? (
              <div className="ask-why">
                <MessageText text={a.why.trim()} />
              </div>
            ) : null}
          </div>
          {a.links?.length ? (
            <div className="ask-links">
              {a.links.map((l) =>
                // An ask whose step is in another thread links it as
                // thread:<id>: opened here, as the Mac and the phone do.
                /^thread:/i.test(l.url) ? (
                  <a
                    key={l.url}
                    className="btn primary"
                    href={linkTo(l.url.slice(7))}
                    onClick={(ev) => {
                      ev.preventDefault();
                      go(linkTo(l.url.slice(7)));
                    }}
                  >
                    {l.title}
                  </a>
                ) : /^review:/i.test(l.url) && openReview ? (
                  // A show_options review in this thread: its board opens over the page.
                  <button key={l.url} className="btn primary" onClick={() => openReview(l.url.slice(7).trim())} title="Open the design review">
                    {l.title}
                  </button>
                ) : (
                  <OutLink key={l.url} className="btn primary" href={l.url}>
                    {l.title} ↗
                  </OutLink>
                ),
              )}
            </div>
          ) : null}
          {choices(a).length ? (
            <div className="choices">
              {choices(a).map((c, n) => (
                <button key={n} className={`choice ${by[i] === n ? 'on' : ''}`} disabled={holding} onClick={() => pickAsk(i, n)}>
                  <span className="radio" />
                  <span>
                    {c}
                    {a.suggested === n ? <span className="pick"><span className="star" aria-hidden>★</span> Recommended</span> : null}
                    {/* What the answer does, under it as on the Mac and the phone. The
                        parity run's first look at the website found it missing (9 Nov). */}
                    {a.options?.length && a.optionNotes?.[n]?.trim() ? <span className="desc">{a.optionNotes[n]}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </Fragment>
      )))}
    </section>
  ) : next.length || ends.length ? (
    <section className="card">
      <h2>
        Done
        <button className="btn plain" style={{ marginLeft: 'auto' }} disabled={archiving} onClick={onArchive}>
          Archive
        </button>
      </h2>
      {ends.length ? (
        <div className="loose-ends">
          <div className="loose-label">{ends.some((e) => e.kind !== 'scheduled') ? 'Still open' : 'Coming back'}</div>
          {ends.map((e, i) => (
            <div key={i} className={`loose ${e.kind === 'scheduled' ? 'booked' : 'open'}`}>
              <span className="loose-mark" aria-label={e.kind === 'scheduled' ? 'Booked' : 'Still open'}>{e.kind === 'scheduled' ? '🕘' : '!'}</span>
              {e.threadId ? (
                <a
                  href={threadPath(e.threadId)}
                  onClick={(ev) => {
                    ev.preventDefault();
                    go(threadPath(e.threadId!));
                  }}
                >
                  {e.text}
                </a>
              ) : (
                <span>{e.kind === 'scheduled' && e.at ? `${bookedWhen(e.at)}: ${e.text}` : e.text}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {next.length ? (() => {
        const pickOne = t.nextPick === 'one' && next.length > 1;
        return (
          <div className="choices">
            <div className="loose-label">{pickOne ? 'Or pick one' : 'Or carry on'}</div>
            {next.map((n, i) => {
              const on = ticked.seq === lastSeq && ticked.set.has(i);
              const suggested = pickOne && t.nextSuggested === i;
              return (
                <button
                  key={i}
                  className={`choice ${on ? 'on' : ''}`}
                  disabled={holding}
                  onClick={() => {
                    const set = new Set(ticked.seq === lastSeq ? ticked.set : []);
                    if (on) set.delete(i);
                    else {
                      if (pickOne) set.clear();
                      set.add(i);
                    }
                    setTicked({ seq: lastSeq, set });
                  }}
                >
                  <span className={pickOne ? 'radio' : 'radio check'} />
                  <span>
                    {n}
                    {suggested ? <span className="pick"><span className="star" aria-hidden>★</span> Recommended</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })() : null}
    </section>
  ) : null;

  const ready = !!text.trim() || Object.values(by).some((n) => n >= 0) || follow.length > 0;
  return (
    <>
    {sending.watch}
    <CommandNote command={sending} />
    <CommandNote command={stopCmd} />
    <div className={`box ${t.pendingApproval || asks.length ? 'asking' : ''}`}>
      {card}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={text}
          readOnly={holding}
          rows={Math.min(10, Math.max(1, text.split('\n').length))}
          placeholder={busy(t) ? 'Steer the agent' : asks.length ? 'Reply, or pick above' : 'Reply'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Return sends, Shift-Return is a new line, as on the Mac. On a
            // phone's keyboard Return is a new line and the button sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="tools-row">
          <span className="grow" />
          {busy(t) && !ready ? (
            // Stop only while nothing's typed, as on the Mac: a message
            // typed during a turn goes into it.
            <button type="button" className="send" disabled={stopLocked} onClick={stop} aria-label={stopLocked ? 'Stopping' : 'Stop'} title={stopLocked ? 'Stopping' : 'Stop'}>
              {stopping ? <span className="spinner" /> : <Icon.Stop />}
            </button>
          ) : (
            <button className="send" disabled={!ready || holding} aria-label={holding ? 'Sending' : 'Send'} title={holding ? 'Sending' : 'Send'}>
              {sending.state.kind === 'sending' ? <span className="spinner" /> : <Icon.Up />}
            </button>
          )}
        </div>
      </form>
    </div>
    </>
  );
}

// What an ask offers: its options, else the reply it wants ("done").
function choices(a: Ask): string[] {
  if (a.options?.length) return a.options;
  return a.reply?.trim() ? [a.reply.trim()] : [];
}

// The message the Mac sends for picked asks (Decisions.message): each
// question then its answer, numbered when the card had several, then
// anything else typed.
function answerMessage(count: number, answers: { index: number; action: string; answer: string }[], extra: string): string {
  const parts = answers.map((a) => (count === 1 ? `${a.action}\n${a.answer}` : `${a.index + 1}. ${a.action}\n   ${a.answer.replace(/\n/g, '\n   ')}`));
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

// Ticked follow-ups (Decisions.followUpMessage): one on its own, several as
// a list, then anything else typed.
function followUpMessage(follow: string[], extra: string): string {
  let body = follow.length === 1 ? follow[0]! : follow.map((f) => `- ${f}`).join('\n');
  if (extra) body += `\n\n${extra}`;
  return body;
}

// Keyed on the approval, so a new one starts with nothing pressed. Once its
// runner takes the answer the card goes; until then the pressed button
// spins and none take clicks, and a failure says why on the card.
function ApprovalCard({ token, threadId, approval }: { token: string; threadId: string; approval: Approval }) {
  const respond = useMutation(api.phone.respond);
  const answer = useMutation(api.phone.answer);
  const secret = useMutation(api.phone.secret);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  // Which button was pressed, for its spinner.
  const reply = useCommand<string>(token, { keepDone: true });
  const pressed = (b: string) => (reply.state.kind === 'sending' || reply.state.kind === 'waiting') && reply.state.payload === b;

  if (approval.kind === 'approval') {
    const label = { allow: 'Allow', allowAlways: 'Always allow', deny: 'Deny' } as Record<string, string>;
    return (
      <section className="card">
        <h2>{approval.title || approval.name}</h2>
        {approval.reason ? <p className="muted">{approval.reason}</p> : null}
        {approval.inputSummary ? <pre className="approval-input">{approval.inputSummary}</pre> : null}
        <div className="ask-links">
          {approval.options.map((o) => (
            <button key={o} className={`btn ${o === 'allow' ? 'primary' : ''}`} disabled={reply.busy} onClick={() => void reply.run(() => respond({ token, threadId, approvalId: approval.approvalId, decision: o as 'allow' | 'allowAlways' | 'deny' }), o)}>
              {pressed(o) ? <span className="spinner" /> : null}
              {label[o] ?? o}
            </button>
          ))}
        </div>
        <CommandNote command={reply} className="in-card" />
      </section>
    );
  }

  if (approval.kind === 'secret') {
    // The browser doesn't take secrets (docs/protocol/threads.md, "Secrets"): the
    // Mac app and the iPhone app do, the phone sealing it to the runner.
    return (
      <section className="card">
        <h2>{approval.label}</h2>
        <p>{approval.reason}</p>
        <p className="desc">Answer this in Threadbear on your Mac or iPhone.</p>
        <div className="ask-links">
          <button className="btn" disabled={reply.busy} onClick={() => void reply.run(() => secret({ token, threadId, approvalId: approval.approvalId, decline: true }), 'decline')}>
            {pressed('decline') ? <span className="spinner" /> : null}
            Decline
          </button>
        </div>
        <CommandNote command={reply} className="in-card" />
      </section>
    );
  }

  const ready = approval.questions.every((q) => answers[q.question]?.length);
  return (
    <section className="card">
      {approval.questions.map((q) => (
        <Fragment key={q.question}>
          <div className="ask-q">{q.question}</div>
          <div className="choices">
            {q.options.map((o) => {
              const chosen = answers[q.question]?.includes(o.label) ?? false;
              return (
                <button
                  key={o.label}
                  className={`choice ${chosen ? 'on' : ''}`}
                  disabled={reply.busy}
                  onClick={() =>
                    setAnswers((a) => {
                      const cur = a[q.question] ?? [];
                      const next = q.multiSelect ? (chosen ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
                      return { ...a, [q.question]: next };
                    })
                  }
                >
                  <span className={`radio ${q.multiSelect ? 'check' : ''}`} />
                  <span>
                    {o.label}
                    {o.description ? <span className="desc">{o.description}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </Fragment>
      ))}
      <div className="ask-links">
        <button
          className="btn primary"
          disabled={!ready || reply.busy}
          onClick={() => {
            // Multi-select choices go in one comma-joined string, as the Mac app sends them.
            const flat = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.join(', ')]));
            void reply.run(() => answer({ token, threadId, approvalId: approval.approvalId, answers: flat }), 'answer');
          }}
        >
          {pressed('answer') ? <span className="spinner" /> : null}
          Answer
        </button>
      </div>
      <CommandNote command={reply} className="in-card" />
    </section>
  );
}

// ------------------------------------------------------------ bits

function originLabel(origin: string): string {
  return origin === 'schedule' ? 'Scheduled' : origin === 'runner' ? 'From Threadbear' : origin === 'agent' ? 'From another thread' : origin;
}
