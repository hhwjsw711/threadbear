// What the pane beside the thread draws (`dump`'s `panels.pane`, the same
// shape on both apps), for the highlights, previews, patches and folder steps.
import type { Dump } from './driver.ts';

export type PaneRow = { title: string; lead?: string | null; trailing?: string | null; note?: string | null; detail?: string | null; symbol?: string | null; ticked?: boolean | null; tone?: string | null; /** A list row's drawn symbol: its own icon, else its tone's shape. */ mark?: string | null; /** Its tone's shape beside the title, for a row with its own icon. */ toneMark?: string | null; /** A list row's switch (`toggle`); `pending` while a press is on its way. */ switch?: { id: string; on: boolean; symbol: string; pending: boolean } | null };
export type PaneBriefQuestion = { id: string; title: string; note?: string | null; tag: string; urgent: boolean; kind: string };
export type PaneBriefThread = { id: string; title: string; running: boolean; tag: string };
export type PaneSection = {
  key: string;
  title: string;
  count: number;
  folded: boolean;
  rows: PaneRow[];
  hasCoordinator?: boolean;
  coordinatorOpenTasks?: number;
  state?: string | null;
  stateUpdated?: string | null;
  collapsedSummary?: string | null;
  questions?: PaneBriefQuestion[];
  openThreads?: PaneBriefThread[];
};
export type Pane = {
  section: string;
  empty?: string | null;
  brief?: string[] | null;
  cards?: string[] | null;
  sections?: PaneSection[] | null;
  patches?: { id: string; source: string; waiting?: string | null; trusting?: boolean | null; gives?: string | null; error?: string | null; file?: string | null; changes?: string[]; diffs?: string[] }[] | null;
  list?: PaneSection[] | null;
  image?: string | null;
  previewKind?: string | null;
  previewText?: string | null;
  artifactReady?: boolean;
  artifactUrl?: string | null;
  artifactVisibility?: 'private' | 'public' | null;
  /** The find bar's words and where the picked match is: "the: 2 of 8", "the: not found". */
  previewFind?: string | null;
  /** The line over a text file: the conflict bar's words, or the grey note. */
  previewNote?: string | null;
  /** What the bar offers: "preview" or "markdown" (a Markdown file's menu), "reading" or "editing" (the pencil and Done). */
  previewMode?: string | null;
  /** The lines tinted for a link that named them (`a.ts:2-3`): "2-3". */
  previewLines?: string | null;
  folder?: string | null;
};

type WithPane = Dump & { panels?: { preview?: string | null; highlights?: string | null; fetchingHighlights?: boolean; pane?: Pane | null; items?: { id: string; title: string; kind: string; active: boolean }[] } | null };

export const pane = (d: Dump): Pane | undefined => (d as WithPane).panels?.pane ?? undefined;
// With / between its parts whatever the system: on Windows a path has backslashes.
export const previewLine = (d: Dump): string | undefined => (d as WithPane).panels?.preview?.replaceAll('\\', '/') ?? undefined;
// The preview line without " (editing)": code and plain text open with their
// own text up to type in, which is still that file showing.
export const previewShown = (d: Dump): string | undefined => previewLine(d)?.replace(/ \(editing\)$/, '');
export const paneItems = (d: Dump) => (d as WithPane).panels?.items ?? [];
export const highlightsFetching = (d: Dump): boolean => (d as WithPane).panels?.fetchingHighlights ?? false;
export const sections = (d: Dump): PaneSection[] => pane(d)?.sections ?? [];
export const section = (d: Dump, title: string) => sections(d).find((s) => s.title === title);
export const row = (d: Dump, heading: string, title: string) => section(d, heading)?.rows.find((r) => r.title === title);
