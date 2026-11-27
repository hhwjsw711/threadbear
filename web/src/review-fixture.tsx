// The review board with sample data and a pretend backend (web/review-fixture.html),
// for checking it with no runner: the stills are drawn here, sends are kept in
// window.__reviewSent and cut-outs in window.__reviewUploads. ?fail=1 makes
// the first send fail; ?answered=1 shows an answered review; ?id= picks one
// ('' for the list). Dev only.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DesignReviews } from './review-board';
import type { ReviewBackend, ReviewPicture } from './review-backend';
import type { DesignReview } from './review-model';
import './styles.css';

const params = new URLSearchParams(location.search);
const src = (n: number) => `review:demo:${String(n).padStart(64, '0')}`;

function still(w: number, h: number, hue: number, label: string, rows: number): Promise<ReviewPicture> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = `hsl(${hue} 30% 96%)`;
  g.fillRect(0, 0, w, h);
  g.fillStyle = `hsl(${hue} 25% 88%)`;
  g.fillRect(0, 0, w * 0.26, h);
  g.fillStyle = `hsl(${hue} 70% 45%)`;
  g.fillRect(w * 0.32, h * 0.07, w * 0.4, h * 0.06);
  for (let i = 0; i < rows; i++) {
    g.fillStyle = i === 1 ? `hsl(${hue} 70% 55%)` : `hsl(${hue} 15% 70%)`;
    g.fillRect(w * 0.03, h * (0.1 + i * 0.07), w * 0.2, h * 0.035);
    g.fillStyle = `hsl(${hue} 10% 80%)`;
    g.fillRect(w * 0.32, h * (0.2 + i * 0.09), w * 0.6, h * 0.05);
  }
  g.fillStyle = '#222';
  g.font = `bold ${Math.round(h * 0.06)}px system-ui`;
  g.fillText(label, w * 0.33, h * 0.9);
  return new Promise((resolve) => c.toBlob((b) => resolve({ url: URL.createObjectURL(b!), width: w, height: h }), 'image/png'));
}

// A second of a tone, as a WAV.
function tone(): ReviewPicture {
  const rate = 8000;
  const n = rate;
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o: number, s: string) => [...s].forEach((ch, i) => buf.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  buf.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  w(36, 'data');
  buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 440) * 8000, true);
  return { url: URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })) };
}

const review: DesignReview = {
  id: 'demo',
  title: 'Sidebar directions',
  note: 'Three ways to tidy the **sidebar**. A keeps today’s rows but tighter; B gives each thread a card; C groups by project. I’d pick **A**: it changes least and fixes the crowding.',
  recommended: 'A',
  status: params.get('answered') ? 'answered' : 'pending',
  revision: 4,
  canMark: true,
  draft: { notes: {}, nextMark: 1, markCount: 1 },
  options: [
    {
      id: 'A',
      title: 'Tighter rows',
      note: 'Same rows, 20% less height, the unread dot moves left.',
      shots: [{ src: src(1), kind: 'image', title: 'Inbox', marks: [{ kind: 'circle', box: [0.02, 0.15, 0.24, 0.2], note: 'the unread dot moves here', ink: 'yellow' }, { kind: 'underline', box: [0.33, 0.07, 0.72, 0.13], note: 'title stays', ink: 'green' }] }],
    },
    {
      id: 'B',
      title: 'Cards',
      note: 'Each thread a card with its last reply. Roomier, but half as many fit.',
      shots: [
        { src: src(2), kind: 'image', marks: [{ kind: 'highlight', box: [0.32, 0.38, 0.92, 0.43], note: 'too much text?', ink: 'rose' }] },
        { src: src(3), kind: 'video', title: 'Opening a card', media: src(30) },
      ],
    },
    { id: 'C', title: 'By project', shots: [{ src: src(4), kind: 'image' }, { src: src(5), kind: 'audio', title: 'The new sound', media: src(50) }] },
    { id: 'Today', title: 'Today', reference: true, shots: [{ src: src(6), kind: 'image' }] },
  ],
};

declare global {
  interface Window {
    __reviewSent: unknown[];
    __reviewUploads: number[];
  }
}
window.__reviewSent = [];
window.__reviewUploads = [];
let failNext = params.get('fail') === '1';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pictures = Promise.all([
  still(1280, 800, 210, 'A', 8),
  still(1280, 800, 150, 'B', 5),
  still(800, 1200, 150, 'B, opening', 6),
  still(1280, 800, 30, 'C', 7),
  still(1280, 800, 280, 'C sound', 3),
  still(1280, 800, 0, 'Today', 10),
]).then((list) => {
  const m = new Map<string, ReviewPicture>();
  list.forEach((p, i) => m.set(src(i + 1), p));
  m.set(src(50), tone());
  return m;
});

const backend: ReviewBackend = {
  async load(id) {
    await wait(400);
    if (id === undefined) return { reviews: [{ id: 'demo', title: review.title }] };
    return { review };
  },
  pictures(_sources, on) {
    let live = true;
    void pictures.then((m) => live && on(m));
    return () => {
      live = false;
    };
  },
  async upload(jpeg) {
    await wait(150);
    window.__reviewUploads.push(jpeg.size);
    return `kg${window.__reviewUploads.length}`;
  },
  async discard() {},
  async respond(_r, draft) {
    await wait(900);
    if (failNext) {
      failNext = false;
      throw new Error('The review changed on the Mac.');
    }
    window.__reviewSent.push(draft);
    return 'done';
  },
};

function Page() {
  const [open, setOpen] = useState(true);
  if (!open) return <p style={{ padding: 20 }} id="closed">Closed. <button onClick={() => setOpen(true)}>Open again</button></p>;
  return <DesignReviews backend={backend} threadId="t1" reviewId={params.get('id') ?? 'demo'} onClose={() => setOpen(false)} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
