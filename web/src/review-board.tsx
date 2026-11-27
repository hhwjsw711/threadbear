// A design review as the Mac's comparison board, over the whole window: the
// agent's lead as a yellow sticky, then the options in one row left to
// right, staggered, each a column with a soft glow, its big letter, its
// pictures and the agent's handwritten notes beside them. Drag to move,
// wheel or pinch to zoom; ‹ › flies along the agent's tour. A video or
// sound's Play pill plays it where it is; the tools circle, highlight or pin
// part of a picture, which the reply points at as "[Mark n]". A port of the
// iPhone's ReviewBoard.swift and DesignReviewsView.swift (the Mac's
// desktop/gpui/src/review_window/canvas.rs is the source of truth); the
// logic is review-model.ts.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { MessageText } from './messages';
import * as Icon from './icons';
import { useConvex } from 'convex/react';
import { convexReviews, type ReviewBackend, type ReviewPicture } from './review-backend';
import {
  addMark,
  canSend,
  clampZoom,
  draftArgument,
  ease,
  finishDrawing,
  fit,
  isPending,
  htmlLabelWidth,
  litDims,
  litOption,
  litShows,
  litShowsWords,
  M,
  markStrokes,
  nextMarkNumber,
  optionLabel,
  OVER_PREFIX,
  overNote,
  part,
  pathData,
  pick,
  pickNone,
  picks,
  pointerStrokes,
  removeMark,
  reopening,
  reviewSources,
  screenRect,
  seedOf,
  sendLabel,
  shotAt,
  standard,
  stopIndex,
  stops as tourStops,
  swipeStroke,
  through,
  toScreen,
  toward,
  toWorld,
  wheelAction,
  zoomAt,
  layout as layBoard,
  cutOutRect,
  type BoardLayout,
  type Camera,
  type DesignReview,
  type Lit,
  type Point,
  type Rect,
  type ReviewDraft,
  type ReviewShot,
  type Stop,
  type Tool,
  type UserMark,
} from './review-model';

// The phone's own drafts, by thread and review, while this page is open:
// closing the board and opening it again keeps what was typed and marked.
const drafts = new Map<string, ReviewDraft>();

// ------------------------------------------------------------ loading and sending

export function DesignReviews({ backend, threadId, reviewId, onClose }: { backend: ReviewBackend; threadId: string; reviewId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<{ id: string; title: string }[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [review, setReview] = useState<DesignReview>();
  const [draft, setDraftState] = useState<ReviewDraft>({ notes: {} });
  const [pictures, setPictures] = useState<Map<string, ReviewPicture>>(new Map());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const sendingRef = useRef(false);
  const reviewRef = useRef<DesignReview | undefined>(undefined);
  const draftRef = useRef(draft);
  // For send and load, which run outside a render.
  useLayoutEffect(() => {
    draftRef.current = draft;
    reviewRef.current = review;
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const key = (id: string) => `${threadId}:${id}`;

  const setDraft = useCallback(
    (next: ReviewDraft) => {
      setDraftState(next);
      const r = reviewRef.current;
      if (r) drafts.set(`${threadId}:${r.id}`, next);
      // Gone once enough marks are removed.
      setProblem((p) => (p?.startsWith(OVER_PREFIX) && overNote(next) !== p ? overNote(next) : p));
    },
    [threadId],
  );

  const load = useCallback(
    async (id: string | undefined, preserveDraft = false) => {
      setLoading(true);
      if (!preserveDraft) setProblem(undefined);
      try {
        const result = await backend.load(id);
        if (!alive.current) return;
        if (result.review) {
          const loaded = result.review;
          const kept = preserveDraft && reviewRef.current?.id === loaded.id ? draftRef.current : drafts.get(key(loaded.id));
          // The Mac's marks as they are now, whichever draft is kept: the Mac may have added some since.
          const d = reopening(loaded, kept);
          reviewRef.current = loaded;
          setReview(loaded);
          setDraftState(d);
          if (isPending(loaded)) {
            const over = overNote(d);
            if (over) setProblem(over);
          }
        } else {
          setEntries(result.reviews ?? []);
          setTruncated(!!result.truncated);
          reviewRef.current = undefined;
          setReview(undefined);
        }
      } catch (e) {
        if (alive.current) setProblem(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key only reads threadId
    [backend, threadId],
  );

  // Once: going back to the list mustn't reopen the review it started on.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load(reviewId || undefined);
  }, [load, reviewId]);

  // The stills and media, as the runner puts them up.
  const reviewKey = review ? `${review.id}:${review.revision}` : '';
  useEffect(() => {
    const r = reviewRef.current;
    if (!r) return;
    setPictures(new Map());
    return backend.pictures(reviewSources(r), setPictures, (error) => setProblem(`Couldn’t load the review pictures. Your answer is still here. ${error}`));
  }, [backend, reviewKey]);

  const send = useCallback(async () => {
    const r = reviewRef.current;
    const d = draftRef.current;
    if (!r || sendingRef.current || !canSend(d, r)) return;
    sendingRef.current = true;
    setSending(true);
    setProblem(undefined);
    try {
      // A runner that would drop them gets none (the tools are hidden there too).
      const outgoing: ReviewDraft = r.canMark ? d : { ...d, marks: undefined };
      // Fresh cut-outs every attempt, never kept in the draft: Convex deletes
      // a command's pictures when it fails or lapses, so a kept id would fail
      // every retry. Let go of this attempt's if it fails.
      const uploaded: string[] = [];
      let result: Awaited<ReturnType<ReviewBackend['respond']>>;
      try {
        const cutOuts = new Map<number, string>();
        for (const m of outgoing.marks ?? []) {
          const jpeg = await cutOut(r, m, pictures);
          if (!jpeg) continue;
          const id = await backend.upload(jpeg);
          uploaded.push(id);
          cutOuts.set(m.n, id);
        }
        result = await backend.respond(r, draftArgument(outgoing, cutOuts));
      } catch (e) {
        for (const id of uploaded) void backend.discard(id).catch(() => undefined);
        throw e;
      }
      if (!alive.current) return;
      if (result === 'done') {
        drafts.delete(key(r.id));
        onClose();
        return;
      }
      // Still on its way: it lands when the Mac is back, so nothing's reloaded over it.
      setProblem(result.waiting);
    } catch (e) {
      if (!alive.current) return;
      setProblem(`${e instanceof Error ? e.message : String(e)} Your answer is kept. Reload before sending again.`);
      // Never retry a write automatically against a newer revision.
      sendingRef.current = false;
      setSending(false);
      await load(r.id, true);
      return;
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key only reads threadId
  }, [backend, load, onClose, pictures, threadId]);

  if (review) {
    return (
      <ReviewBoard
        review={review}
        draft={draft}
        setDraft={setDraft}
        pictures={pictures}
        sending={sending}
        loading={loading}
        problem={problem}
        onClose={onClose}
        onAllReviews={() => {
          drafts.set(key(review.id), draftRef.current);
          void load(undefined);
        }}
        onReload={() => void load(review.id, true)}
        onSend={() => void send()}
      />
    );
  }
  return (
    <div className="rb rb-list-page" role="dialog" aria-modal="true" aria-label="Design reviews" tabIndex={-1} ref={focusOnOpen}>
      <header className="rb-list-head">
        <button className="rb-round" onClick={onClose} aria-label="Close" title="Close">
          <Icon.Close />
        </button>
        <h2>Reviews</h2>
        <span className="rb-round-space" />
      </header>
      <div className="rb-list">
        {loading ? (
          <div className="rb-wait">
            <span className="spinner" /> Waiting for the thread’s runner…
            <p className="rb-faint">The runner must be online to read or answer a review.</p>
          </div>
        ) : null}
        {problem ? (
          <div className="rb-problem" role="alert">
            <span>{problem}</span>
            <button className="btn" disabled={loading || sending} onClick={() => void load(reviewId || undefined, true)}>
              Reload review
            </button>
          </div>
        ) : null}
        {!loading && !entries.length && !problem ? <p className="rb-faint">No pending reviews.</p> : null}
        {!loading
          ? entries.map((e) => (
              <button key={e.id} className="rb-entry" disabled={loading} onClick={() => void load(e.id)} title="Opens the design options">
                <span>{e.title}</span>
                <Icon.Chevron />
              </button>
            ))
          : null}
        {truncated ? <p className="rb-faint">Showing the first 100 reviews. Answer these to see the rest.</p> : null}
      </div>
    </div>
  );
}

// Each mark's part of its still, cut out as a JPEG for the runner to show
// beside the mark's line. A still the browser can't read leaves the mark
// without one: its box still goes.
async function cutOut(review: DesignReview, mark: UserMark, pictures: Map<string, ReviewPicture>): Promise<Blob | undefined> {
  const shot = review.options.find((o) => o.id === mark.optionId)?.shots[mark.shot];
  const still = shot ? pictures.get(shot.src) : undefined;
  if (!still) return undefined;
  try {
    const img = new Image();
    // The storage answers with CORS, so the canvas stays readable.
    img.crossOrigin = 'anonymous';
    img.src = still.url;
    await img.decode();
    const r = cutOutRect(mark.box, img.naturalWidth, img.naturalHeight);
    if (!r) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = r.w;
    canvas.height = r.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, r.w, r.h);
    ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, r.w, r.h);
    return await new Promise<Blob | undefined>((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), 'image/jpeg', 0.8));
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ the board

type ShotKey = `${number}:${number}`;
const shotKey = (o: number, s: number): ShotKey => `${o}:${s}`;

type Playback = { key?: ShotKey; playing: boolean; loading?: ShotKey; progress: number; failed: Set<ShotKey> };

type Gesture =
  | { kind: 'pan'; last: Point; moved: number; down: Point; tap: boolean }
  | { kind: 'pinch'; anchor: Point; dist: number; scale: number }
  | { kind: 'draw'; tool: Exclude<Tool, 'move'>; points: Point[] }
  | { kind: 'none' };

const INK: Record<string, string> = { yellow: '#F3B01C', green: '#6FD08C', rose: '#F07A9A' };
const inkOf = (ink?: string) => INK[ink ?? ''] ?? INK.yellow!;
// A highlight is as wide on screen as the Mac's marker.
const MARKER = 22;

function ReviewBoard({
  review,
  draft,
  setDraft,
  pictures,
  sending,
  loading,
  problem,
  onClose,
  onAllReviews,
  onReload,
  onSend,
}: {
  review: DesignReview;
  draft: ReviewDraft;
  setDraft: (d: ReviewDraft) => void;
  pictures: Map<string, ReviewPicture>;
  sending: boolean;
  loading: boolean;
  problem?: string;
  onClose: () => void;
  onAllReviews: () => void;
  onReload: () => void;
  onSend: () => void;
}) {
  const pending = isPending(review);
  const busy = sending || loading;
  const canMark = review.canMark === true;
  const [toolPicked, setTool] = useState<Tool>('move');
  const [showNotes, setShowNotes] = useState(true);
  const [markLimitHit, setMarkLimitHit] = useState(false);
  // A mark being drawn, in world units. Not shown while sending: it's given up.
  const [drawingNow, setDrawing] = useState<{ tool: Exclude<Tool, 'move'>; points: Point[] } | null>(null);
  const drawing = busy ? null : drawingNow;
  const nextN = nextMarkNumber(draft);
  // Back to moving once there's no room for another mark.
  const tool: Tool = nextN === undefined && !drawing ? 'move' : toolPicked;
  const drawingOn = tool !== 'move' && canMark && pending && !busy;
  const [menu, setMenu] = useState(false);

  // ---- measuring the words, so the layout matches what's drawn
  const measureRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<{ words: Map<string, number>; notes: Map<string, { w: number; h: number }> }>();
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([document.fonts.load(`${M.noteSize}px Caveat`), document.fonts.ready])
      .catch(() => undefined)
      .then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, []);
  const measureKey = `${review.id}:${review.revision}:${fontsReady}`;
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const words = new Map<string, number>();
    const notes = new Map<string, { w: number; h: number }>();
    el.querySelectorAll<HTMLElement>('[data-words]').forEach((n) => words.set(n.dataset.words!, n.offsetHeight));
    el.querySelectorAll<HTMLElement>('[data-note]').forEach((n) => notes.set(n.dataset.note!, { w: Math.min(M.noteWidth, Math.ceil(n.getBoundingClientRect().width)), h: n.offsetHeight }));
    setSizes({ words, notes });
  }, [measureKey]);

  // Each still's own size, from the runner or, failing that, once it's loaded.
  const [natural, setNatural] = useState<Map<string, number>>(new Map());
  const aspect = useCallback(
    (shot: ReviewShot) => {
      const p = pictures.get(shot.src);
      if (p?.width && p.height) return p.width / p.height;
      return natural.get(shot.src) ?? 4 / 3;
    },
    [pictures, natural],
  );

  const board = useMemo<BoardLayout | undefined>(() => {
    if (!sizes) return undefined;
    return layBoard(review, aspect, {
      words: (text, width) => sizes.words.get(`${width}:${text}`) ?? M.wordsSize * 1.5,
      note: (text) => sizes.notes.get(text) ?? { w: M.noteWidth, h: M.noteSize * 1.1 },
    });
  }, [review, aspect, sizes]);
  const stops = useMemo<Stop[]>(() => (board ? tourStops(board) : []), [board]);

  // ---- the camera
  const canvasRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 0, h: 0, top: 0, bottom: 0 });
  useLayoutEffect(() => {
    const read = () => {
      const c = canvasRef.current?.getBoundingClientRect();
      const top = chromeRef.current?.getBoundingClientRect().bottom ?? 0;
      const bottom = bandRef.current?.getBoundingClientRect().top ?? c?.height ?? 0;
      if (c) setView((v) => (v.w === c.width && v.h === c.height && v.top === top && v.bottom === bottom ? v : { w: c.width, h: c.height, top, bottom }));
    };
    read();
    const ro = new ResizeObserver(read);
    for (const el of [canvasRef.current, chromeRef.current, bandRef.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [pending, problem]);
  const area = useMemo<Rect>(() => {
    const bottom = view.bottom > view.top + 40 ? view.bottom : view.h;
    return { x: 0, y: view.top, w: view.w, h: Math.max(1, bottom - view.top) };
  }, [view]);

  const [camera, setCameraState] = useState<Camera>({ s: 0.4, tx: 0, ty: 0 });
  const cameraRef = useRef(camera);
  const setCamera = (c: Camera) => {
    cameraRef.current = c;
    setCameraState(c);
  };
  const flight = useRef<{ from: Camera; to: Camera; start: number; frame: number } | null>(null);
  const [stop, setStop] = useState(0);
  // Moved by hand: nothing's dimmed, and the camera isn't refitted.
  const [roaming, setRoaming] = useState(false);
  // What the camera was last placed for: the tour (new when the stills' sizes
  // change the layout) and the screen.
  const placed = useRef<{ stops: Stop[]; view: typeof view } | null>(null);

  const land = () => {
    if (!flight.current) return;
    cancelAnimationFrame(flight.current.frame);
    flight.current = null;
  };
  const fly = (to: Camera) => {
    land();
    const from = cameraRef.current;
    const f = { from, to, start: performance.now(), frame: 0 };
    const step = () => {
      if (flight.current !== f) return;
      const k = (performance.now() - f.start) / M.flightMs;
      if (k >= 1) {
        flight.current = null;
        setCamera(to);
        return;
      }
      setCamera(toward(f.from, f.to, ease(k), view));
      f.frame = requestAnimationFrame(step);
    };
    flight.current = f;
    f.frame = requestAnimationFrame(step);
  };
  useEffect(() => () => land(), []);
  const cameraFor = (s: Stop) => fit(s.rect, area, 12, M.stopZoom);

  // The opening stop once the screen's size is known, and again when it or
  // the layout changes (a still's real size arriving), unless moved by hand.
  useLayoutEffect(() => {
    if (!stops.length || view.w <= 0 || view.bottom <= view.top) return;
    if (placed.current?.stops === stops && placed.current.view === view) return;
    const first = placed.current === null;
    placed.current = { stops, view };
    let at = Math.min(stop, stops.length - 1);
    if (first) {
      at = Math.max(0, stops.findIndex((s) => s.lit.kind === 'start'));
      setStop(at);
    }
    if (first || !roaming) {
      land();
      setCamera(cameraFor(stops[at]!));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- placed again only when the stops or the screen change, never on a flight
  }, [stops, view]);

  const go = (i: number) => {
    const s = stops[i];
    if (!s) return;
    setStop(i);
    setRoaming(false);
    fly(cameraFor(s));
  };
  const seeAll = () => go(stops.length - 1);
  // A tap on a picture: to its stop, and if already there, closer, to the picture alone.
  const lookCloser = (o: number, s: number) => {
    const i = stopIndex(stops, o, s);
    if (i < 0) return;
    const picture = board?.options[o]?.shots[s]?.picture;
    if (stop === i && !roaming && picture) {
      setRoaming(true);
      fly(fit(picture, area, 8, M.maxZoom));
    } else go(i);
  };
  const lit: Lit | undefined = !roaming && stops[stop] && litDims(stops[stop]!.lit) ? stops[stop]!.lit : undefined;

  // ---- playing videos and sounds, one at a time
  const [playback, setPlayback] = useState<Playback>({ playing: false, progress: 0, failed: new Set() });
  const media = useRef<HTMLMediaElement | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stopPlaying = () => {
    media.current?.pause();
    audio.current?.pause();
    audio.current = null;
    setPlayback((p) => ({ ...p, key: undefined, playing: false, loading: undefined, progress: 0 }));
  };
  useEffect(() => () => audio.current?.pause(), []);
  const failPlay = (k: ShotKey) => setPlayback((p) => (p.key === k || p.loading === k ? { ...p, key: undefined, playing: false, loading: undefined, progress: 0, failed: new Set([...p.failed, k]) } : p));
  const togglePlay = (k: ShotKey, shot: ReviewShot, url: string) => {
    if (playback.key === k) {
      const el = shot.kind === 'audio' ? audio.current : media.current;
      if (!el) return;
      if (playback.playing) {
        el.pause();
        setPlayback((p) => ({ ...p, playing: false }));
      } else {
        if (el.ended) el.currentTime = 0;
        void el.play().catch(() => failPlay(k));
        setPlayback((p) => ({ ...p, playing: true }));
      }
      return;
    }
    stopPlaying();
    if (shot.kind === 'audio') {
      const a = new Audio(url);
      audio.current = a;
      a.ontimeupdate = () => a.duration > 0 && setPlayback((p) => (p.key === k ? { ...p, progress: Math.min(1, a.currentTime / a.duration) } : p));
      a.onended = () => setPlayback((p) => (p.key === k ? { ...p, playing: false, progress: 1 } : p));
      a.onerror = () => failPlay(k);
      a.onplaying = () => setPlayback((p) => (p.loading === k ? { ...p, loading: undefined } : p));
      setPlayback((p) => ({ ...p, key: k, playing: true, loading: k, progress: 0 }));
      void a.play().catch(() => failPlay(k));
    } else {
      // The <video> is drawn over the still once key is set, and plays itself.
      setPlayback((p) => ({ ...p, key: k, playing: true, loading: k, progress: 0 }));
    }
  };

  // ---- drawing marks
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const placeMark = (mark: Omit<UserMark, 'n'>) => {
    if (busy) return;
    const el = replyRef.current;
    const focused = el && document.activeElement === el;
    const added = addMark(draft, mark, focused ? { start: el.selectionStart, end: el.selectionEnd } : undefined);
    if (!added) {
      setMarkLimitHit(true);
      return;
    }
    setDraft(added.draft);
    if (focused) requestAnimationFrame(() => el.setSelectionRange(added.caret, added.caret));
  };

  // ---- the pointer: one drags or draws, two pinch
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>({ kind: 'none' });
  const lastTap = useRef<{ at: number; p: Point } | null>(null);
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gesture.current = { kind: 'pinch', anchor: toWorld(cameraRef.current, mid), dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: cameraRef.current.s };
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = local(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, p);
    land();
    if (pointers.current.size >= 2) {
      // Only a mark being drawn is given up: two fingers move the board.
      setDrawing(null);
      setRoaming(true);
      startPinch();
      return;
    }
    if (drawingOn && nextN !== undefined) {
      const t = tool as Exclude<Tool, 'move'>;
      const w = toWorld(cameraRef.current, p);
      gesture.current = { kind: 'draw', tool: t, points: [w] };
      setDrawing({ tool: t, points: [w] });
      return;
    }
    if (drawingOn && nextN === undefined) setMarkLimitHit(true);
    gesture.current = { kind: 'pan', last: p, moved: 0, down: p, tap: true };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = clampZoom((g.scale * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist);
      setCamera({ s, tx: mid.x - g.anchor.x * s, ty: mid.y - g.anchor.y * s });
    } else if (g.kind === 'pan') {
      const dx = p.x - g.last.x;
      const dy = p.y - g.last.y;
      g.last = p;
      g.moved += Math.abs(dx) + Math.abs(dy);
      if (g.moved > 5) {
        g.tap = false;
        if (!roaming) setRoaming(true);
        const c = cameraRef.current;
        setCamera({ ...c, tx: c.tx + dx, ty: c.ty + dy });
      }
    } else if (g.kind === 'draw' && g.tool !== 'pin') {
      const w = toWorld(cameraRef.current, p);
      const last = g.points.at(-1)!;
      if (Math.hypot(w.x - last.x, w.y - last.y) * cameraRef.current.s >= 3 && g.points.length < 400) {
        g.points = [...g.points, w];
        setDrawing({ tool: g.tool, points: g.points });
      }
    }
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g.kind === 'pinch') {
      // One finger left: it carries on moving the board, never a tap.
      const rest = [...pointers.current.values()][0];
      gesture.current = rest ? { kind: 'pan', last: rest, moved: 99, down: rest, tap: false } : { kind: 'none' };
      return;
    }
    gesture.current = { kind: 'none' };
    if (g.kind === 'draw') {
      setDrawing(null);
      if (e.type === 'pointercancel' || busy || !board) return;
      const mark = finishDrawing(board, review, g.tool, g.points, MARKER / 2 / cameraRef.current.s);
      if (mark) placeMark(mark);
      return;
    }
    if (g.kind === 'pan' && g.tap && e.type !== 'pointercancel' && board) {
      const p = local(e);
      const w = toWorld(cameraRef.current, p);
      const shot = shotAt(board, w);
      const now = performance.now();
      const double = lastTap.current && now - lastTap.current.at < 350 && Math.hypot(p.x - lastTap.current.p.x, p.y - lastTap.current.p.y) < 30;
      lastTap.current = { at: now, p };
      if (shot) lookCloser(shot.option, shot.shot);
      else if (double) seeAll();
    }
  };

  // The wheel: a mouse zooms round the pointer, a trackpad moves (review-model.ts, wheelAction).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      land();
      const a = wheelAction({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, metaKey: e.metaKey, wheelDeltaY: (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY });
      const c = cameraRef.current;
      setCamera(a.kind === 'zoom' ? zoomAt(c, local(e), a.factor) : { ...c, tx: c.tx + a.dx, ty: c.ty + a.dy });
      setRoaming(true);
    };
    // Safari's trackpad pinch comes as gesture events rather than ctrl-wheels.
    let gestureScale = 1;
    const gStart = (e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    };
    const gChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const c = cameraRef.current;
      setCamera(zoomAt(c, local(g), g.scale / gestureScale));
      gestureScale = g.scale;
      setRoaming(true);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('gesturestart', gStart);
    el.addEventListener('gesturechange', gChange);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('gesturestart', gStart);
      el.removeEventListener('gesturechange', gChange);
    };
  }, []);

  // Keys: Escape closes; the arrows walk the tour while not typing.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (e.key === 'Escape') {
        if (menu) setMenu(false);
        else if (typing) (e.target as HTMLElement).blur();
        else onClose();
      } else if (!typing && e.key === 'ArrowRight') go(Math.min(stops.length - 1, stop + 1));
      else if (!typing && e.key === 'ArrowLeft') go(Math.max(0, stop - 1));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // The world is memoized through pans; zoom also changes label clearance.
  const chosen = picks(draft);
  const world = useMemo(() => {
    if (!board) return null;
    const dim = (on: boolean) => (on ? 1 : 0.2);
    const size = { w: Math.max(1, maxRight(board)), h: Math.max(1, maxBottom(board)) };
    return (
      <>
        {board.options.map((laid) => {
          const option = review.options[laid.index]!;
          const picked = chosen.has(option.id);
          const mine = lit ? litOption(lit) === laid.index : true;
          return (
            <Fragment key={`b${laid.index}`}>
              <div className={`rb-halo ${picked ? 'picked' : ''}`} style={{ ...place(laid.halo), opacity: mine ? 1 : 0.55 }} />
              <div className={`rb-letter ${picked ? 'picked' : ''}`} style={{ left: laid.letter.x, top: laid.letter.y - M.letterSize * 0.1, opacity: mine ? 1 : 0.55 }} aria-hidden>
                {option.id}
              </div>
            </Fragment>
          );
        })}
        {board.lead && review.note ? (
          <div className="rb-lead" style={{ ...place(board.lead), opacity: dim(!lit || lit.kind === 'lead') }}>
            <MessageText text={review.note} />
          </div>
        ) : null}
        {board.options.map((laid) => {
          const option = review.options[laid.index]!;
          const picked = chosen.has(option.id);
          const first = laid.shots[0];
          const html = first && option.shots[0]?.kind === 'page';
          const shrink = Math.min(26, Math.max(Math.min(12, 640 * camera.s / 18), 26 * camera.s)) / (26 * camera.s);
          const labelWidth = html ? htmlLabelWidth({...laid.title, h: Math.max(laid.title.h, 26 * shrink * 1.4)}, first.picture, camera.s) : laid.title.w;
          return (
            <Fragment key={`c${laid.index}`}>
              <div className="rb-title" style={{...place(laid.title), ...(html ? {width: labelWidth, overflow: 'hidden'} : {})}}>
                <div className="rb-title-in" style={html ? {width: labelWidth / shrink, minWidth: 0} : undefined}>
                  {!option.reference && pending ? (
                    <button
                      className={`rb-tick ${picked ? 'on' : ''}`}
                      disabled={busy}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setDraft(pick(draft, option.id, !picked))}
                      aria-label={`Choose ${option.id}, ${option.title}`}
                      aria-pressed={picked}
                      title={picked ? `Untick ${option.id}` : `Tick ${option.id}`}
                    >
                      {picked ? <Icon.Check /> : null}
                    </button>
                  ) : null}
                  <button className="rb-name" style={html ? {minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto'} : undefined} onPointerDown={(e) => e.stopPropagation()} onClick={() => go(stopIndex(stops, laid.index, 0))} title="Show it on the board">
                    {optionLabel(option)}
                  </button>
                  {review.recommended === option.id && labelWidth * camera.s >= 190 ? (
                    <span className="rb-tag">
                      <span className="rb-star">★</span> Recommended
                    </span>
                  ) : null}
                  {option.reference ? <span className="rb-tag">Reference</span> : null}
                </div>
              </div>
              {laid.shots.map((s) => {
                const shot = option.shots[s.shot]!;
                const on = lit ? litShows(lit, laid.index, s.shot) : true;
                const k = shotKey(laid.index, s.shot);
                const pic = pictures.get(shot.src);
                const mediaUrl = shot.media ? pictures.get(shot.media)?.url : undefined;
                return (
                  <Fragment key={k}>
                    {picked ? <div className="rb-ring" style={{ ...place({ x: s.picture.x - 6, y: s.picture.y - 6, w: s.picture.w + 12, h: s.picture.h + 12 }), opacity: dim(on) }} /> : null}
                    <div className="rb-shot" style={{ ...place(s.picture), opacity: dim(on) }} aria-label={pictureLabel(option.id, option.title, shot)} role="img">
                      <Still
                        key={pic?.url ?? ''}
                        url={pic?.url}
                        preview={shot.preview !== false}
                        onSize={(w, h) => !pic?.width && setNatural((m) => (m.get(shot.src) === w / h ? m : new Map(m).set(shot.src, w / h)))}
                      />
                      {playback.key === k && shot.kind === 'video' && mediaUrl ? (
                        <video
                          ref={(el) => {
                            media.current = el;
                          }}
                          src={mediaUrl}
                          autoPlay
                          playsInline
                          crossOrigin="anonymous"
                          onPlaying={() => setPlayback((p) => (p.loading === k ? { ...p, loading: undefined } : p))}
                          onEnded={() => setPlayback((p) => (p.key === k ? { ...p, playing: false, progress: 1 } : p))}
                          onError={() => failPlay(k)}
                        />
                      ) : null}
                      {playback.key === k && shot.kind === 'audio' ? <div className="rb-progress" style={{ width: `${playback.progress * 100}%` }} /> : null}
                    </div>
                    {s.caption.h > 0 ? (
                      <div className="rb-caption" style={{ ...place(s.caption), width: shot.kind === 'page' ? htmlLabelWidth(s.caption, s.picture, camera.s) : s.caption.w, opacity: dim(on) }}>
                        {shot.title ?? `${s.shot + 1} of ${option.shots.length}`}
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
              {laid.words && option.note ? (
                <div className="rb-words" style={{ left: laid.words.x, top: laid.words.y, width: laid.words.w, opacity: dim(lit ? litShowsWords(lit, laid.index) : true) }}>
                  <MessageText text={option.note} />
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {/* The agent's marks as the Mac draws them: a looping circle, a double
            underline, a marker swipe, and from each note a curled pointer with
            an open head; the notes in Caveat in the margin beside the picture. */}
        <svg className="rb-ink" width={size.w} height={size.h} aria-hidden>
          {showNotes
            ? board.options.flatMap((lo) => {
                const option = review.options[lo.index]!;
                return lo.shots.flatMap((s) => {
                  const marks = option.shots[s.shot]!.marks ?? [];
                  const on = lit ? litShows(lit, s.option, s.shot) : true;
                  return [
                    ...marks.map((m, i) => {
                      const strokes = markStrokes(s.picture, m, seedOf(s.option, s.shot, i));
                      if (!strokes.length) return null;
                      const highlight = m.kind === 'highlight';
                      return (
                        <path
                          key={`m${s.option}-${s.shot}-${i}`}
                          d={pathData(strokes)}
                          className={highlight ? 'rb-swipe' : 'rb-line'}
                          stroke={inkOf(m.ink)}
                          style={{ opacity: dim(on) * (highlight ? 0.3 : 1), ...(highlight ? { strokeWidth: Math.abs(part(s.picture, m.box).h) * 1.05 } : {}) }}
                        />
                      );
                    }),
                    ...s.notes.map((n) => (marks[n.mark] ? <path key={`p${s.option}-${s.shot}-${n.mark}`} d={pathData(pointerStrokes(n))} className="rb-line" stroke={inkOf(marks[n.mark]!.ink)} style={{ opacity: dim(on) }} /> : null)),
                  ];
                });
              })
            : null}
          {(draft.marks ?? []).map((m) => {
            const where = markPlace(board, review, m);
            if (!where || m.kind === 'pin') return null;
            const stroke = where.points.length > 1 ? through(where.points) : undefined;
            if (m.kind === 'highlight') return <path key={`u${m.n}`} className="rb-mine-swipe" d={pathData([stroke ?? swipeStroke(where.part)])} style={{ strokeWidth: `max(${where.part.h * 0.85}px, calc(4px / var(--s)))` }} />;
            if (stroke) return <path key={`u${m.n}`} className="rb-mine" d={pathData([stroke])} />;
            return <ellipse key={`u${m.n}`} className="rb-mine" cx={where.part.x + where.part.w / 2} cy={where.part.y + where.part.h / 2} rx={where.part.w / 2} ry={where.part.h / 2} />;
          })}
        </svg>
        {showNotes
          ? board.options.flatMap((lo) =>
              lo.shots.flatMap((s) => {
                const marks = review.options[lo.index]!.shots[s.shot]!.marks ?? [];
                const on = lit ? litShows(lit, s.option, s.shot) : true;
                return s.notes.map((n) =>
                  marks[n.mark] ? (
                    <div key={`n${s.option}-${s.shot}-${n.mark}`} className="rb-note" style={{ left: n.rect.x, top: n.rect.y, width: n.rect.w + 4, color: inkOf(marks[n.mark]!.ink), opacity: dim(on) }}>
                      {marks[n.mark]!.note}
                    </div>
                  ) : null,
                );
              }),
            )
          : null}
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lit by its parts, so a new object for the same stop doesn't redraw the board
  }, [board, camera.s, review, draft, lit?.kind, lit && litOption(lit), lit?.kind === 'shot' ? lit.shot : -1, showNotes, pictures, busy, pending, playback, stops]);

  const s = camera.s;
  // The dot grid: 2 px dots on a 48-unit grid that stays 18 to 36 px apart on screen.
  let gap = 48;
  while (gap * s < 18) gap *= 2;
  while (gap * s > 36) gap /= 2;
  const g = gap * s;
  const rem = (a: number) => ((a % g) + g) % g;

  return (
    <div className="rb" role="dialog" aria-modal="true" aria-label={review.title} tabIndex={-1} ref={focusOnOpen}>
      <div
        ref={canvasRef}
        className={`rb-canvas ${drawingOn ? 'drawing' : ''}`}
        style={{ backgroundSize: `${g}px ${g}px`, backgroundPosition: `${rem(camera.tx) - g / 2}px ${rem(camera.ty) - g / 2}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="rb-world" style={{ transform: `translate(${camera.tx}px, ${camera.ty}px) scale(${s})`, '--s': s } as CSSProperties}>
          {world}
          {drawing && drawing.points.length > 1 ? (
            <svg className="rb-ink" width={1} height={1} aria-hidden>
              <path className={drawing.tool === 'highlight' ? 'rb-mine-swipe drawing' : 'rb-mine'} d={pathData([through(drawing.points)])} />
            </svg>
          ) : null}
        </div>
        {/* On the screen, not zoomed: the marks' numbers and the play pills. */}
        {board
          ? (draft.marks ?? []).map((m) => {
              const where = markPlace(board, review, m);
              if (!where) return null;
              const pin = m.kind === 'pin';
              const spot = toScreen(camera, pin ? (where.points[0] ?? { x: where.part.x, y: where.part.y }) : { x: where.part.x, y: where.part.y });
              return (
                <div key={`badge${m.n}`} className={`rb-badge ${pin ? 'pin' : ''}`} style={{ left: spot.x - 13, top: pin ? spot.y - 26 : spot.y - 13 }} aria-hidden>
                  {m.n}
                </div>
              );
            })
          : null}
        {board
          ? board.options.flatMap((lo) =>
              lo.shots.map((sl) => {
                const shot = review.options[lo.index]!.shots[sl.shot]!;
                if (shot.kind !== 'video' && shot.kind !== 'audio' && shot.kind !== 'page') return null;
                const r = screenRect(camera, sl.picture);
                if (r.w < (shot.kind === 'page' ? 210 : 90) || r.x + r.w <= 0 || r.x >= view.w || r.y + r.h <= 0 || r.y >= view.h) return null;
                const k = shotKey(lo.index, sl.shot);
                const url = shot.media ? pictures.get(shot.media)?.url : undefined;
                const playing = playback.key === k && playback.playing;
                const page = shot.kind === 'page';
                const failed = page || !url || playback.failed.has(k);
                const top = view.top + 8;
                const [right, y] = page ? [r.x + r.w, r.y - 32] : !playing ? [r.x + r.w - 8, Math.max(r.y + 8, Math.min(top, r.y + r.h - 34))] : r.y - 34 >= top ? [r.x + r.w, r.y - 34] : [r.x + r.w, r.y + r.h + 8];
                const label = page ? 'Interact on Mac or iPhone' : failed ? 'Play on the Mac' : playing ? 'Stop' : 'Play';
                return (
                  <button
                    key={`play${k}`}
                    className="rb-play"
                    style={page ? { left: r.x + r.w - 210, width: 210, top: y, justifyContent: 'center' } : { right: view.w - right, top: y }}
                    disabled={failed}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => url && togglePlay(k, shot, url)}
                    title={page ? 'HTML stays a snapshot here. The Mac and iPhone seal its scripts with network and WebRTC blocked.' : failed ? `This ${shot.kind === 'audio' ? 'sound' : 'video'} plays on the Mac` : `${label} ${review.options[lo.index]!.id}, ${shot.title ?? (shot.kind === 'audio' ? 'sound' : 'video')}`}
                  >
                    {playback.loading === k ? <span className="spinner" /> : failed ? <Icon.Server /> : playing ? <Icon.StopFill /> : shot.kind === 'audio' ? <Icon.Note /> : <Icon.Play />}
                    {label}
                  </button>
                );
              }),
            )
          : null}
        {!board ? (
          <div className="rb-wait center">
            <span className="spinner" />
          </div>
        ) : null}
      </div>

      {/* The words, laid out unseen, so the board's layout matches what's drawn. */}
      <div className="rb-measure" ref={measureRef} aria-hidden>
        {review.note?.trim() ? (
          <div className="rb-words" data-words={`${M.leadWidth - 48}:${review.note}`} style={{ width: M.leadWidth - 48 }}>
            <MessageText text={review.note} />
          </div>
        ) : null}
        {review.options.map((o) =>
          o.note?.trim() ? (
            <div key={o.id} className="rb-words" data-words={`${M.pictureWidth}:${o.note}`} style={{ width: M.pictureWidth }}>
              <MessageText text={o.note} />
            </div>
          ) : null,
        )}
        {[...new Set(review.options.flatMap((o) => o.shots.flatMap((sh) => (sh.marks ?? []).flatMap((m) => (m.note ? [m.note] : [])))))].map((note) => (
          <div key={note} className="rb-note measuring" data-note={note}>
            {note}
          </div>
        ))}
      </div>

      <div className="rb-chrome" ref={chromeRef}>
        <div className="rb-top">
          <button className="rb-round" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon.Close />
          </button>
          <div className="rb-title-menu">
            <button className="rb-heading" onClick={() => setMenu((m) => !m)} title="All reviews, reload" aria-expanded={menu}>
              <span>{review.title}</span>
              <Icon.ChevronDown />
            </button>
            {menu ? (
              <div className="rb-menu" role="menu">
                <button
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setMenu(false);
                    onAllReviews();
                  }}
                  title="The thread's pending reviews"
                >
                  All reviews
                </button>
                <button
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setMenu(false);
                    onReload();
                  }}
                  title="Load this review again from the Mac, keeping your answer"
                >
                  Reload review
                </button>
              </div>
            ) : null}
          </div>
          <span className="rb-round-space" />
        </div>
        <div className="rb-tools">
          {canMark && pending && (tool !== 'move' || nextN !== undefined) ? (
            <>
              <ToolButton tool="move" current={tool} set={setTool} busy={busy} name="Move and zoom" icon={<Icon.Hand />} clear={() => setMarkLimitHit(false)} />
              <ToolButton tool="circle" current={tool} set={setTool} busy={busy} name="Circle a part" icon={<Icon.Circle />} clear={() => setMarkLimitHit(false)} />
              <ToolButton tool="highlight" current={tool} set={setTool} busy={busy} name="Highlight a part" icon={<Icon.Highlighter />} clear={() => setMarkLimitHit(false)} />
              <ToolButton tool="pin" current={tool} set={setTool} busy={busy} name="Drop a pin" icon={<Icon.Pin />} clear={() => setMarkLimitHit(false)} />
              <span className="rb-divider" />
            </>
          ) : null}
          <button className={`rb-switch ${showNotes ? 'on' : ''}`} onClick={() => setShowNotes((n) => !n)} aria-pressed={showNotes} title={showNotes ? "Hide the agent's notes" : "Show the agent's notes"}>
            <span className="rb-knob" />
            Notes
          </button>
          <button className="rb-tool-text" onClick={seeAll} title="Fit everything on the screen">
            See all
          </button>
        </div>
        {drawingOn || markLimitHit ? (
          <div className="rb-hint">
            {markLimitHit && nextN === undefined ? 'That’s the most marks one answer can have.' : tool === 'pin' ? 'Click or tap a picture to drop a pin.' : tool === 'highlight' ? 'Drag over part of a picture to highlight it.' : 'Drag round part of a picture to circle it.'}
          </div>
        ) : null}
      </div>

      <div className="rb-band" ref={bandRef}>
        {problem ? (
          <div className="rb-problem" role="alert">
            <span>{problem}</span>
            <button className="rb-link" onClick={onReload} disabled={busy} title="Load the review again, keeping your answer">
              Reload
            </button>
          </div>
        ) : null}
        <div className="rb-tour">
          <button className="rb-step" onClick={() => go(stop - 1)} disabled={stop <= 0} aria-label="Back" title="Back (←)">
            <Icon.Back />
          </button>
          <span className="rb-count">
            {stop + 1} of {Math.max(1, stops.length)}
          </span>
          <button className="rb-step next" onClick={() => go(stop + 1)} disabled={stop >= stops.length - 1} aria-label="Next" title="Next (→)">
            <Icon.Back />
          </button>
          {loading ? <span className="spinner" title="Loading the review" /> : null}
        </div>
        {pending ? (
          <>
            {(draft.marks ?? []).length ? (
              <div className="rb-chips">
                {[...(draft.marks ?? [])]
                  .sort((a, b) => a.n - b.n)
                  .map((m) => (
                    <span key={m.n} className="rb-chip">
                      <button
                        className="rb-chip-go"
                        onClick={() => {
                          const o = review.options.findIndex((x) => x.id === m.optionId);
                          if (o >= 0) lookCloser(o, m.shot);
                        }}
                        title="Show the marked picture"
                      >
                        <span className="rb-chip-n">{m.n}</span> on {m.optionId}
                      </button>
                      <button
                        className="rb-chip-x"
                        disabled={busy}
                        onClick={() => setDraft(removeMark(draft, m.n))}
                        aria-label={`Remove mark ${m.n}`}
                        title={`Remove mark ${m.n}`}
                      >
                        <Icon.Close />
                      </button>
                    </span>
                  ))}
              </div>
            ) : null}
            <textarea
              ref={replyRef}
              className="rb-reply"
              placeholder="Add a reply"
              rows={1}
              value={draft.reply ?? ''}
              disabled={busy}
              onChange={(e) => {
                const next = { ...draft };
                if (e.target.value) next.reply = e.target.value;
                else delete next.reply;
                setDraft(next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!busy && canSend(draft, review)) onSend();
                }
              }}
              title="Your reply. Marks go in as [Mark n]; ⌘Return sends"
            />
            <div className="rb-actions">
              <button className={`rb-none ${draft.none ? 'on' : ''}`} disabled={busy} onClick={() => setDraft(pickNone(draft, !draft.none))} aria-pressed={!!draft.none} title={draft.none ? 'Take back none of them' : 'None of them will do'}>
                None of them
              </button>
              <button className={`rb-send ${sending ? 'sending' : ''}`} disabled={busy || !canSend(draft, review)} onClick={onSend} title="Send your answer to the thread">
                {sending ? <span className="spinner" /> : null}
                {sendLabel(draft, review, sending)}
              </button>
            </div>
          </>
        ) : (
          <p className="rb-faint">This review is {review.status}. Answer it on the Mac if it’s still open there.</p>
        )}
      </div>
    </div>
  );
}

function ToolButton({ tool, current, set, busy, name, icon, clear }: { tool: Tool; current: Tool; set: (t: Tool) => void; busy: boolean; name: string; icon: ReactNode; clear: () => void }) {
  const on = tool === current;
  return (
    <button
      className={`rb-tool ${on ? 'on' : ''}`}
      disabled={busy && tool !== 'move'}
      onClick={() => {
        set(tool);
        clear();
      }}
      aria-label={name}
      aria-pressed={on}
      title={name}
    >
      {icon}
    </button>
  );
}

// A shot's still on the board, at the size the board gives it.
function Still({ url, preview, onSize }: { url?: string; preview: boolean; onSize: (w: number, h: number) => void }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!preview) return <div className="rb-still-note">No preview here. Open it on the Mac.</div>;
  if (!url) return <div className="rb-still-note">The preview is on its way from the Mac.</div>;
  if (failed) return <div className="rb-still-note">Couldn’t load this picture.</div>;
  return (
    <>
      {!loaded ? <span className="spinner rb-still-spin" /> : null}
      <img
        src={url}
        alt=""
        draggable={false}
        crossOrigin="anonymous"
        onLoad={(e) => {
          setLoaded(true);
          const img = e.currentTarget;
          if (img.naturalWidth && img.naturalHeight) onSize(img.naturalWidth, img.naturalHeight);
        }}
        onError={() => setFailed(true)}
      />
    </>
  );
}

// The keys go to the board once it's open, not to the sidebar's list
// (whose arrows would open another thread) or the page under it.
function focusOnOpen(el: HTMLDivElement | null) {
  if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
}

function place(r: Rect): CSSProperties {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

function maxRight(b: BoardLayout) {
  return b.bounds.x + b.bounds.w;
}
function maxBottom(b: BoardLayout) {
  return b.bounds.y + b.bounds.h;
}

// Where one of the browser's marks is on the board: its box and stroke.
function markPlace(board: BoardLayout, review: DesignReview, m: UserMark): { part: Rect; points: Point[] } | undefined {
  const o = review.options.findIndex((x) => x.id === m.optionId);
  const laid = board.options[o]?.shots[m.shot];
  if (!laid) return undefined;
  const p = laid.picture;
  return { part: standard(part(p, m.box)), points: (m.path ?? []).flatMap((q) => (q.length === 2 ? [{ x: p.x + q[0]! * p.w, y: p.y + q[1]! * p.h }] : [])) };
}

function pictureLabel(id: string, title: string, shot: ReviewShot): string {
  const kind = shot.kind === 'video' ? ', video' : shot.kind === 'audio' ? ', sound' : shot.kind === 'page' ? ', page' : '';
  const notes = (shot.marks ?? []).flatMap((m) => (m.note ? [m.note] : []));
  return `${id}, ${title}: ${shot.title ?? 'picture'}${kind}${notes.length ? `. Marked: ${notes.join('; ')}` : ''}`;
}

// The board for a thread on Mike's page, reading and answering through Convex.
export default function ThreadReviews({ token, threadId, reviewId, onClose }: { token: string; threadId: string; reviewId: string; onClose: () => void }) {
  const client = useConvex();
  const backend = useMemo(() => convexReviews(client, token, threadId), [client, token, threadId]);
  return <DesignReviews backend={backend} threadId={threadId} reviewId={reviewId} onClose={onClose} />;
}
