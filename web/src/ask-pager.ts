// Paging a card of several asks, matching desktop's composer_card.rs so both
// decide the same way for the same card. Pure, so it can be unit tested.

type PagedAsk = { action: string; why?: string; options?: string[]; optionNotes?: string[]; reply?: string };

// Desktop measures in points (composer_card.rs mod metrics; BODY_LINE from style.rs).
const HEADING = 20;
const HEADING_SPACING = 6;
const ASK_BEFORE = 12;
const ASK_AFTER = 2;
const BUTTONS_BEFORE = 6;
const BUTTON_LINE = 38;
const BODY_LINE = 23;
const NOTED_ROW = 38;
// Characters on a line of the reading column, and the height past which a
// card pages (is_paged).
const WIDTH_CHARS = 95;
const PAGED_OVER = 240;

// An ask's paragraph, action then why (ask_paragraph): a full stop goes
// between them unless the action already ends a sentence. Desktop also
// escapes a leading markdown marker, one character the estimate ignores.
function paragraph(a: PagedAsk): string {
  const action = a.action
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
  const why = (a.why ?? '').trim();
  if (!why) return action;
  const last = [...action].reverse().find((c) => !'"\'”’)]*_`'.includes(c));
  const ends = last !== undefined && '.?!…:'.includes(last);
  return `${action}${ends ? '' : '.'} ${why}`;
}

// Whether the card is too tall to show every ask at once (is_paged). The web
// ask has no "where" line, so that term is omitted.
export function isPaged(asks: PagedAsk[]): boolean {
  if (asks.length < 2) return false;
  let height = HEADING + HEADING_SPACING;
  for (const a of asks) {
    const lines = paragraph(a)
      .split('\n')
      .reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / WIDTH_CHARS)), 0);
    // Without notes the answers are a line of buttons; with them, a row each
    // and one for the ask's own answer.
    const answers = a.optionNotes?.length ? NOTED_ROW * ((a.options?.length ?? 0) + 1) : ASK_AFTER + BUTTONS_BEFORE + BUTTON_LINE;
    height += ASK_BEFORE + lines * BODY_LINE + answers;
  }
  return height > PAGED_OVER;
}

// The ask to move to after a pick (next_unanswered in composer.rs): the ones
// after `index`, wrapping, then `index` itself if `orThis`; the first with no
// pick. A pick of -1 is an unpick on the web.
export function nextUnanswered(index: number, count: number, by: Record<number, number>, orThis: boolean): number | null {
  if (count === 0) return null;
  const order: number[] = [];
  for (let step = 1; step < count; step++) order.push((index + step) % count);
  if (orThis) order.push(index);
  return order.find((i) => by[i] === undefined || by[i]! < 0) ?? null;
}
