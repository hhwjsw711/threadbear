//! The message box's spelling and substitutions, as the Swift app's
//! NSTextView gives them: what to mark, what to correct after a word's typed,
//! and the Edit menu's Transformations. The Mac's spell checker
//! (`gpui/src/text_services.rs`) finds the words; this decides what's done
//! with what it found, so it's tested without a Mac.
use std::ops::Range;

/// What the spell checker found, by kind (NSTextCheckingType).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Spelling,
    Grammar,
    /// An autocorrection of a misspelled word.
    Correction,
    /// The Mac's text replacements (Keyboard > Text Replacements).
    Replacement,
    Quote,
    Dash,
}

/// One thing found, with a byte range into the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub range: Range<usize>,
    pub kind: Kind,
    /// What to put in its place (corrections, replacements, quotes, dashes).
    pub replacement: Option<String>,
}

/// Which marks to draw, `true` for grammar (green) and `false` for spelling
/// (red). As NSTextView, the word the caret is in or just after isn't marked
/// while it's being typed; and nothing inside `skip` (a picture's chip) is.
pub fn marks(
    found: &[Found],
    caret: Option<usize>,
    skip: &[Range<usize>],
) -> Vec<(Range<usize>, bool)> {
    found
        .iter()
        .filter_map(|f| match f.kind {
            Kind::Spelling => Some((f.range.clone(), false)),
            Kind::Grammar => Some((f.range.clone(), true)),
            _ => None,
        })
        .filter(|(r, grammar)| *grammar || !caret.is_some_and(|c| r.start <= c && c <= r.end))
        .filter(|(r, _)| !skip.iter().any(|s| s.start < r.end && r.start < s.end))
        .collect()
}

/// Where each Markdown link's address is, the `(...)` after a `]`, as the #
/// thread picker puts in (`[Title](thread:<id>)`): an address isn't words, so
/// it's never marked as misspelt or corrected.
pub fn link_targets(text: &str) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find("](") {
        let start = from + at + 2;
        match text[start..].find([')', '\n']) {
            Some(len) if text[start + len..].starts_with(')') => {
                found.push(start..start + len);
                from = start + len + 1;
            }
            _ => from = start,
        }
    }
    found
}

/// The one character typed to make `new` from `old`, ending at `caret`, when
/// it ends a word (a space, a new line or punctuation): what sets off an
/// autocorrection or a text replacement, and a quote or dash substitution.
pub fn typed_boundary(old: &str, new: &str, caret: usize) -> Option<char> {
    if new.len() <= old.len() || caret > new.len() || !new.is_char_boundary(caret) {
        return None;
    }
    let typed = new[..caret].chars().next_back()?;
    let start = caret - typed.len_utf8();
    if new.len() - old.len() != typed.len_utf8()
        || new.get(..start) != old.get(..start)
        || new.get(caret..) != old.get(start..)
    {
        return None;
    }
    ends_word(typed).then_some(typed)
}

fn ends_word(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '.' | ',' | '!' | '?' | ';' | ':' | ')' | ']' | '}' | '"' | '\'' | '-'
        )
}

/// One substitution to make: what goes at `range`, and what kind of check
/// found it (a correction is watched afterwards, `Autocorrect`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Substitution {
    pub range: Range<usize>,
    pub with: String,
    pub kind: Kind,
}

/// The substitutions to make now that `typed` was typed just before `caret`:
/// a correction or replacement of the word right before it, a dash made of
/// what's right before it, or the quote just typed. Last first, so applying
/// them in order keeps the earlier ranges right.
pub fn substitutions(found: &[Found], caret: usize, typed: char) -> Vec<Substitution> {
    let before = caret - typed.len_utf8();
    let mut out: Vec<Substitution> = found
        .iter()
        .filter_map(|f| {
            let with = f.replacement.clone()?;
            let fits = match f.kind {
                Kind::Correction | Kind::Replacement => {
                    f.range.end == before && !matches!(typed, '"' | '\'' | '-')
                }
                Kind::Dash => f.range.end == before || f.range.end == caret,
                Kind::Quote => f.range == (before..caret),
                Kind::Spelling | Kind::Grammar => false,
            };
            (fits && f.range.start < f.range.end).then(|| Substitution {
                range: f.range.clone(),
                with,
                kind: f.kind,
            })
        })
        .collect();
    // A replacement and a correction of the same word: the replacement, as
    // the Mac does it.
    out.sort_by(|a, b| {
        b.range
            .start
            .cmp(&a.range.start)
            .then((b.kind == Kind::Replacement).cmp(&(a.kind == Kind::Replacement)))
    });
    out.dedup_by(|later, earlier| later.range == earlier.range);
    out
}

/// Where each of `subs` (as `substitutions` gives them, last first) ends up
/// once they're all made, in the same order.
pub fn ranges_after(subs: &[Substitution]) -> Vec<Range<usize>> {
    subs.iter()
        .map(|s| {
            let shift: isize = subs
                .iter()
                .filter(|o| o.range.start < s.range.start)
                .map(|o| o.with.len() as isize - o.range.len() as isize)
                .sum();
            let start = (s.range.start as isize + shift) as usize;
            start..start + s.with.len()
        })
        .collect()
}

/// Words the box never marks or corrects, whatever the Mac's dictionary
/// says: the app's own name, which it otherwise turns into "threadbare" as
/// the space after it is typed (Wayne's recording, 17 Nov).
pub const OWN_WORDS: &[&str] = &["Threadbear"];

/// Whether `word` is one of `OWN_WORDS`, in any case, possessive too.
pub fn is_own_word(word: &str) -> bool {
    let word = word
        .strip_suffix("'s")
        .or_else(|| word.strip_suffix("’s"))
        .unwrap_or(word);
    OWN_WORDS.iter().any(|w| w.eq_ignore_ascii_case(word))
}

/// `found` without what it says about `OWN_WORDS`: no mark, no correction.
pub fn without_own_words(text: &str, found: Vec<Found>) -> Vec<Found> {
    found
        .into_iter()
        .filter(|f| {
            !(matches!(f.kind, Kind::Spelling | Kind::Correction)
                && text.get(f.range.clone()).is_some_and(is_own_word))
        })
        .collect()
}

/// What became of an autocorrection, for the spell checker
/// (NSCorrectionResponse): kept, changed to something else, or put back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Response {
    Accepted,
    Edited,
    Reverted,
}

/// An autocorrection's outcome: `word` was typed and corrected to
/// `correction`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub response: Response,
    pub word: String,
    pub correction: String,
}

/// NSTextView's memory for its corrections: when one is taken back (Undo
/// straight after, or deleting into the corrected word and typing the
/// original again), that word isn't corrected again. Without it the box
/// corrected the same word every time it was retyped.
#[derive(Clone, Debug, Default)]
pub struct Autocorrect {
    /// Words whose correction was taken back, lower case.
    declined: std::collections::HashSet<String>,
    /// The last correction, while the edits after it could still take it back.
    last: Option<Made>,
}

#[derive(Clone, Debug)]
struct Made {
    /// The box's text the ranges below are in: each edit is measured
    /// against this, so one the composer didn't see (a smart quote put in,
    /// several keys between checks) still moves them right.
    text: String,
    /// Where the word is now, and what it reads.
    word: Range<usize>,
    now: String,
    /// The end of what was typed after it (the space that set the correction
    /// off): an edit reaching past here isn't about this word.
    after: usize,
    original: String,
    corrected: String,
    /// Edited since it was corrected.
    touched: bool,
}

fn wordy(c: char) -> bool {
    c.is_alphanumeric() || c == '\'' || c == '’'
}

/// The one stretch `old` and `new` differ in: where it starts, and where it
/// ends in each.
fn changed(old: &str, new: &str) -> (usize, usize, usize) {
    let mut prefix = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let room = old.len().min(new.len()) - prefix;
    let mut suffix = old
        .bytes()
        .rev()
        .zip(new.bytes().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
        suffix -= 1;
    }
    (prefix, old.len() - suffix, new.len() - suffix)
}

impl Autocorrect {
    /// Whether a correction of `word` was taken back before.
    pub fn declined(&self, word: &str) -> bool {
        self.declined.contains(&word.to_lowercase())
    }

    /// `found` without corrections of words that were taken back, or of
    /// `OWN_WORDS`, and without marks on `OWN_WORDS`.
    pub fn keep(&self, text: &str, found: Vec<Found>) -> Vec<Found> {
        without_own_words(text, found)
            .into_iter()
            .filter(|f| {
                !(f.kind == Kind::Correction
                    && text.get(f.range.clone()).is_some_and(|w| self.declined(w)))
            })
            .collect()
    }

    /// A correction was just made: `original` became `corrected`, now at
    /// `word` in `text` (the box), with what was typed after it up to
    /// `after`. The one before it is settled, and its outcome returned.
    pub fn made(
        &mut self,
        text: &str,
        word: Range<usize>,
        after: usize,
        original: &str,
        corrected: &str,
    ) -> Option<Outcome> {
        let before = self.settle();
        if text.get(word.clone()) == Some(corrected)
            && after <= text.len()
            && text.is_char_boundary(after)
        {
            self.last = Some(Made {
                text: text.to_owned(),
                now: corrected.to_owned(),
                word,
                after,
                original: original.to_owned(),
                corrected: corrected.to_owned(),
                touched: false,
            });
        }
        before
    }

    /// The box's value was set whole (a send, a draft put back): whatever's
    /// typed next is a new message, so the last correction is settled.
    pub fn reset(&mut self) -> Option<Outcome> {
        self.settle()
    }

    /// The box now reads `new`. When that took the last correction back
    /// (Undo, or the word typed back as it was), the word's declined from
    /// now on and `Reverted` returned; when it moved on, the correction is
    /// settled as `Accepted` or `Edited`.
    pub fn edited(&mut self, new: &str) -> Option<Outcome> {
        let made = self.last.as_mut()?;
        if made.text == new {
            return None;
        }
        let (start, old_end, new_end) = changed(&made.text, new);
        made.text = new.to_owned();
        let grew = new_end as isize - old_end as isize;
        // Typing where the word was, once it's all deleted, is typing it.
        let into_empty = made.word.is_empty() && start == made.word.start;
        if old_end <= made.word.start && !into_empty {
            // Before it: the word moves, unless what's typed joins onto it.
            made.word = (made.word.start as isize + grew) as usize
                ..(made.word.end as isize + grew) as usize;
            made.after = (made.after as isize + grew) as usize;
            if new
                .get(..made.word.start)
                .is_none_or(|before| before.chars().next_back().is_some_and(wordy))
            {
                return self.settle();
            }
            return None;
        }
        if start >= made.after && start > made.word.end {
            // After it: a new word started means it's been let be. (Right at
            // its end, with the space gone, is typing onto the word.)
            return if new[start..new_end].chars().any(char::is_alphanumeric) {
                self.settle()
            } else {
                None
            };
        }
        if start < made.word.start || old_end > made.after {
            // Something bigger than the word (a select-all and delete): it's
            // gone.
            return self.settle();
        }
        // In the word, or the space after it: what does it read now?
        let end = new[made.word.start..]
            .char_indices()
            .find(|(_, c)| !wordy(*c))
            .map_or(new.len(), |(i, _)| made.word.start + i);
        made.word.end = end;
        made.now = new[made.word.start..end].to_owned();
        made.after = ((made.after as isize + grew) as usize).max(end);
        made.touched = true;
        // The original back, or in another case so long as it isn't the
        // correction itself ("i" made "I" is still corrected with only the
        // space after it deleted).
        if made.now == made.original
            || (made.now != made.corrected
                && made.now.to_lowercase() == made.original.to_lowercase())
        {
            let made = self.last.take()?;
            self.declined.insert(made.original.to_lowercase());
            return Some(Outcome {
                response: Response::Reverted,
                word: made.original,
                correction: made.corrected,
            });
        }
        None
    }

    /// The last correction is done with: kept, or changed to something else.
    fn settle(&mut self) -> Option<Outcome> {
        let made = self.last.take()?;
        let response = if made.touched && made.now != made.corrected {
            Response::Edited
        } else {
            Response::Accepted
        };
        Some(Outcome {
            response,
            word: made.original,
            correction: made.corrected,
        })
    }
}

/// The marks of `old` moved to where their words are in `new`, as the box
/// is edited between checks: one changed stretch is found (what's the same
/// at the start and the end), marks after it shift by what it grew or shrank,
/// and a mark it touches goes until the next check.
pub fn shift_marks(
    marks: &[(Range<usize>, bool)],
    old: &str,
    new: &str,
) -> Vec<(Range<usize>, bool)> {
    let prefix = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    let room = old.len().min(new.len()) - prefix;
    let suffix = old
        .bytes()
        .rev()
        .zip(new.bytes().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    let (old_end, new_end) = (old.len() - suffix, new.len() - suffix);
    let wordy = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '\'' || c == '’');
    marks
        .iter()
        .filter_map(|(r, grammar)| {
            if r.end <= prefix {
                Some((r.clone(), *grammar))
            } else if r.start >= old_end {
                Some((
                    (r.start - old_end + new_end)..(r.end - old_end + new_end),
                    *grammar,
                ))
            } else {
                None
            }
        })
        .filter(|(r, _)| new.is_char_boundary(r.start) && new.is_char_boundary(r.end))
        // A word typed onto at either end is a different word now.
        .filter(|(r, _)| {
            !wordy(new[r.end..].chars().next()) && !wordy(new[..r.start].chars().next_back())
        })
        .collect()
}

/// Byte offset in `text` of a UTF-16 offset (an NSRange's), clipped to the end.
pub fn byte_of_utf16(text: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units >= utf16 {
            return i;
        }
        units += c.len_utf16();
    }
    text.len()
}

/// UTF-16 offset of a byte offset in `text`.
pub fn utf16_of_byte(text: &str, byte: usize) -> usize {
    let mut at = byte.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    text[..at].chars().map(char::len_utf16).sum()
}

/// Edit > Transformations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transform {
    Upper,
    Lower,
    Capitalize,
}

impl Transform {
    pub fn apply(self, text: &str) -> String {
        match self {
            Transform::Upper => text.to_uppercase(),
            Transform::Lower => text.to_lowercase(),
            // NSString's capitalizedString: each word's first letter up, the
            // rest down.
            Transform::Capitalize => {
                let mut out = String::with_capacity(text.len());
                let mut start = true;
                for c in text.chars() {
                    if c.is_alphanumeric() {
                        if start {
                            out.extend(c.to_uppercase());
                        } else {
                            out.extend(c.to_lowercase());
                        }
                        start = false;
                    } else {
                        out.push(c);
                        start = c != '\'' && c != '’';
                    }
                }
                out
            }
        }
    }
}

/// What a transformation or Start Speaking works on: the selection, or with
/// none, the word the caret is in (NSTextView's own rule for
/// Transformations).
pub fn word_at(text: &str, at: usize) -> Range<usize> {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    let in_word = |c: char| c.is_alphanumeric() || c == '\'' || c == '’' || c == '_';
    let start = text[..at]
        .char_indices()
        .rev()
        .take_while(|(_, c)| in_word(*c))
        .last()
        .map_or(at, |(i, _)| i);
    let end = text[at..]
        .char_indices()
        .find(|(_, c)| !in_word(*c))
        .map_or(text.len(), |(i, _)| at + i);
    start..end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(range: Range<usize>, kind: Kind, with: Option<&str>) -> Found {
        Found {
            range,
            kind,
            replacement: with.map(str::to_owned),
        }
    }

    fn subs(found: &[Found], caret: usize, typed: char) -> Vec<(Range<usize>, String)> {
        substitutions(found, caret, typed)
            .into_iter()
            .map(|s| (s.range, s.with))
            .collect()
    }

    #[test]
    fn the_word_being_typed_isnt_marked() {
        let f = [
            found(0..3, Kind::Spelling, None),
            found(4..8, Kind::Spelling, None),
        ];
        // "teh wrod" with the caret at the end: only "teh".
        assert_eq!(marks(&f, Some(8), &[]), vec![(0..3, false)]);
        // Once the caret leaves, both.
        assert_eq!(marks(&f, Some(9), &[]), vec![(0..3, false), (4..8, false)]);
        assert_eq!(marks(&f, None, &[]).len(), 2);
    }

    #[test]
    #[expect(
        clippy::single_range_in_vec_init,
        reason = "a selection of one range, as the editor passes them"
    )]
    fn chips_and_substitutions_arent_marked() {
        let f = [
            found(0..3, Kind::Spelling, None),
            found(5..9, Kind::Grammar, None),
            found(10..12, Kind::Correction, Some("x")),
        ];
        assert_eq!(marks(&f, None, &[1..2]), vec![(5..9, true)]);
    }

    #[test]
    fn a_typed_space_is_found() {
        assert_eq!(typed_boundary("hi teh", "hi teh ", 7), Some(' '));
        assert_eq!(typed_boundary("hi teh", "hi teh.", 7), Some('.'));
        // A letter doesn't end a word, and a paste isn't typing.
        assert_eq!(typed_boundary("hi te", "hi teh", 6), None);
        assert_eq!(typed_boundary("hi", "hi there ", 9), None);
        // Typed in the middle.
        assert_eq!(typed_boundary("teh end", "teh  end", 4), Some(' '));
        assert_eq!(typed_boundary("abc", "abc", 3), None);
        assert_eq!(typed_boundary("é", "é ", 3), Some(' '));
        // A whole new value since (a draft put back) with a different start:
        // no slice inside "é".
        assert_eq!(typed_boundary("é the ", "h ello x", 2), None);
    }

    #[test]
    fn only_the_word_before_the_space_is_corrected() {
        let f = [
            found(0..3, Kind::Correction, Some("the")),
            found(4..8, Kind::Correction, Some("word")),
            found(9..12, Kind::Spelling, None),
        ];
        // "teh wrod " typed: the space at 8..9.
        assert_eq!(subs(&f, 9, ' '), vec![(4..8, "word".to_owned())]);
    }

    #[test]
    fn a_replacement_wins_over_a_correction() {
        let f = [
            found(0..3, Kind::Replacement, Some("on my way")),
            found(0..3, Kind::Correction, Some("omg")),
        ];
        assert_eq!(substitutions(&f, 4, ' ').len(), 1);
        assert_eq!(substitutions(&f, 4, ' ')[0].kind, Kind::Replacement);
        // Whichever order the checker gave them in.
        let f = [f[1].clone(), f[0].clone()];
        assert_eq!(substitutions(&f, 4, ' ')[0].kind, Kind::Replacement);
    }

    #[test]
    fn quotes_and_dashes() {
        let f = [
            found(3..4, Kind::Quote, Some("“")),
            found(0..2, Kind::Dash, Some("—")),
        ];
        assert_eq!(subs(&f, 4, '"'), vec![(3..4, "“".to_owned())]);
        assert_eq!(subs(&f, 3, ' '), vec![(0..2, "—".to_owned())]);
    }

    #[test]
    fn marks_move_with_an_edit() {
        let marks = [(0..3, false), (8..12, false)];
        // "teh and wrod" with "big " typed at the start.
        assert_eq!(
            shift_marks(&marks, "teh and wrod", "big teh and wrod"),
            vec![(4..7, false), (12..16, false)]
        );
        // Typing inside a marked word drops its mark until the next check.
        assert_eq!(
            shift_marks(&marks, "teh and wrod", "tehh and wrod"),
            vec![(9..13, false)]
        );
        // Deleting before one moves it back.
        assert_eq!(
            shift_marks(&marks, "teh and wrod", "teh  wrod"),
            vec![(0..3, false), (5..9, false)]
        );
        assert_eq!(
            shift_marks(&marks, "teh and wrod", "teh and wrod"),
            marks.to_vec()
        );
    }

    #[test]
    fn utf16_offsets() {
        let t = "a😀b";
        assert_eq!(byte_of_utf16(t, 1), 1);
        assert_eq!(byte_of_utf16(t, 3), 5);
        assert_eq!(byte_of_utf16(t, 99), 6);
        assert_eq!(utf16_of_byte(t, 5), 3);
    }

    #[test]
    fn transformations() {
        assert_eq!(
            Transform::Capitalize.apply("hello wORLD it's"),
            "Hello World It's"
        );
        assert_eq!(Transform::Upper.apply("straße"), "STRASSE");
        assert_eq!(Transform::Lower.apply("ABC"), "abc");
    }

    #[test]
    fn the_word_at_the_caret() {
        assert_eq!(word_at("hello world", 7), 6..11);
        assert_eq!(word_at("hello world", 5), 0..5);
        assert_eq!(word_at("it's here", 1), 0..4);
        assert_eq!(word_at("a  b", 2), 2..2);
    }

    /// The box going through `steps`, each one the person's edit, telling
    /// `ac` each; what it said back.
    fn type_through(ac: &mut Autocorrect, steps: &[&str]) -> Vec<Outcome> {
        steps.iter().filter_map(|now| ac.edited(now)).collect()
    }

    fn reverted(word: &str, correction: &str) -> Outcome {
        Outcome {
            response: Response::Reverted,
            word: word.into(),
            correction: correction.into(),
        }
    }

    #[test]
    fn threadbear_is_never_marked_or_corrected() {
        let text = "I use threadbear and Threadbear's tour";
        let f = vec![
            found(6..16, Kind::Spelling, None),
            found(6..16, Kind::Correction, Some("threadbare")),
            found(21..33, Kind::Spelling, None),
            found(0..1, Kind::Grammar, None),
        ];
        assert_eq!(
            without_own_words(text, f.clone()),
            vec![found(0..1, Kind::Grammar, None)]
        );
        assert_eq!(
            Autocorrect::default().keep(text, f),
            vec![found(0..1, Kind::Grammar, None)]
        );
        assert!(
            is_own_word("THREADBEAR") && is_own_word("threadbear’s") && !is_own_word("threadbare")
        );
    }

    #[test]
    fn undo_straight_after_a_correction_declines_it() {
        let mut ac = Autocorrect::default();
        // "teh " typed, corrected to "the ".
        assert_eq!(ac.made("the ", 0..3, 4, "teh", "the"), None);
        // Undo puts the word back, with or without the space.
        assert_eq!(
            type_through(&mut ac, &["teh "]),
            vec![reverted("teh", "the")]
        );
        assert!(ac.declined("teh") && ac.declined("TEH"));
        let mut ac = Autocorrect::default();
        ac.made("the ", 0..3, 4, "teh", "the");
        assert_eq!(
            type_through(&mut ac, &["teh"]),
            vec![reverted("teh", "the")]
        );
        // And it's not corrected again, though it's still marked.
        let f = vec![
            found(3..6, Kind::Correction, Some("the")),
            found(3..6, Kind::Spelling, None),
        ];
        assert_eq!(
            ac.keep("ok teh ", f),
            vec![found(3..6, Kind::Spelling, None)]
        );
    }

    #[test]
    fn deleting_into_it_and_typing_the_word_again_declines_it() {
        // Wayne's: "brainz" typed after "hi ", corrected to "brains ".
        let mut ac = Autocorrect::default();
        ac.made("hi brains ", 3..9, 10, "brainz", "brains");
        let steps = ["hi brains", "hi brain", "hi brai", "hi brain", "hi brainz"];
        assert_eq!(
            type_through(&mut ac, &steps),
            vec![reverted("brainz", "brains")]
        );
        assert!(ac.declined("brainz"));
        // Deleting it all and typing it again counts too.
        let mut ac = Autocorrect::default();
        ac.made("brains ", 0..6, 7, "brainz", "brains");
        let mut steps: Vec<String> = (0..7).rev().map(|n| "brains "[..n].to_owned()).collect();
        steps.extend((1..=6).map(|n| "brainz"[..n].to_owned()));
        let steps: Vec<&str> = steps.iter().map(String::as_str).collect();
        assert_eq!(
            type_through(&mut ac, &steps),
            vec![reverted("brainz", "brains")]
        );
        // Or typed back in one go (a paste, dictation).
        let mut ac = Autocorrect::default();
        ac.made("hi brains ", 3..9, 10, "brainz", "brains");
        assert_eq!(
            type_through(&mut ac, &["hi brains", "hi ", "hi brainz"]),
            vec![reverted("brainz", "brains")]
        );
    }

    #[test]
    fn typing_on_keeps_it() {
        let mut ac = Autocorrect::default();
        ac.made("the ", 0..3, 4, "teh", "the");
        let said = type_through(&mut ac, &["the c", "the ca"]);
        assert_eq!(
            said,
            vec![Outcome {
                response: Response::Accepted,
                word: "teh".into(),
                correction: "the".into()
            }]
        );
        assert!(!ac.declined("teh"));
        // Nothing more to say about it.
        assert_eq!(type_through(&mut ac, &["the c", "the "]), vec![]);
    }

    #[test]
    fn changed_to_something_else_is_edited() {
        let mut ac = Autocorrect::default();
        ac.made("the ", 0..3, 4, "teh", "the");
        assert_eq!(
            type_through(&mut ac, &["the", "th", "tho", "thou", "thou "]),
            vec![]
        );
        // The next correction settles it.
        let said = ac.made("thou has ", 5..8, 9, "hsa", "has");
        assert_eq!(
            said,
            Some(Outcome {
                response: Response::Edited,
                word: "teh".into(),
                correction: "the".into()
            })
        );
        assert!(!ac.declined("teh"));
    }

    #[test]
    fn edits_elsewhere_move_it_along() {
        let mut ac = Autocorrect::default();
        ac.made("hi the ", 3..6, 7, "teh", "the");
        // A word typed before it, then Undo of the correction.
        assert_eq!(
            type_through(&mut ac, &["hi, the ", "hi, teh "]),
            vec![reverted("teh", "the")]
        );
        // Typed onto its front, it's a different word.
        let mut ac = Autocorrect::default();
        ac.made("hi the ", 3..6, 7, "teh", "the");
        assert_eq!(type_through(&mut ac, &["hi xthe "]).len(), 1);
        assert_eq!(type_through(&mut ac, &["hi teh "]), vec![]);
        assert!(!ac.declined("teh"));
    }

    #[test]
    fn a_new_message_forgets_it() {
        // A send sets the box's value whole, and the composer says so: the
        // same word typed in the next message isn't a take-back.
        let mut ac = Autocorrect::default();
        ac.made("hi the ", 3..6, 7, "teh", "the");
        assert!(ac.reset().is_some());
        assert_eq!(type_through(&mut ac, &["", "t", "x", "hi teh"]), vec![]);
        assert!(!ac.declined("teh"));
        // Typed over with something new, a later word isn't a take-back.
        let mut ac = Autocorrect::default();
        ac.made("the ", 0..3, 4, "teh", "the");
        assert_eq!(
            type_through(&mut ac, &["s", "so", "so ", "so t", "so te", "so teh"]).len(),
            1
        );
        assert!(!ac.declined("teh"));
    }

    #[test]
    fn a_case_only_correction_kept_isnt_declined() {
        let mut ac = Autocorrect::default();
        ac.made("I ", 0..1, 2, "i", "I");
        assert_eq!(type_through(&mut ac, &["I"]), vec![]);
        assert!(!ac.declined("i"));
        assert_eq!(type_through(&mut ac, &["", "i"]), vec![reverted("i", "I")]);
        // Retyped in another case than it was first typed still counts.
        let mut ac = Autocorrect::default();
        ac.made("threadbare ", 0..10, 11, "threadbear", "threadbare");
        assert_eq!(
            type_through(
                &mut ac,
                &["threadbare", "threadbar", "threadba", "threadbEar"]
            )
            .len(),
            1
        );
    }

    #[test]
    fn option_backspace_on_a_lone_word_then_typing_it_back() {
        let mut ac = Autocorrect::default();
        ac.made("the ", 0..3, 4, "teh", "the");
        assert_eq!(
            type_through(&mut ac, &["the", "", "teh"]),
            vec![reverted("teh", "the")]
        );
    }

    #[test]
    fn edits_it_didnt_see_one_by_one() {
        // A straight quote typed before the word, then the smart quote put
        // in its place (three bytes for one), then Undo of the correction.
        let mut ac = Autocorrect::default();
        ac.made("the ", 0..3, 4, "teh", "the");
        assert_eq!(
            type_through(&mut ac, &["\"the ", "“the ", "“teh "]),
            vec![reverted("teh", "the")]
        );
        // Nothing it's handed panics, whatever the box became.
        for text in ["", "x", "é", "😀😀😀😀", "“", "hi the", "\u{fffc}the "] {
            let mut ac = Autocorrect::default();
            ac.made("hi the ", 3..6, 7, "teh", "the");
            ac.edited(text);
            ac.edited("é😀");
        }
        // A made it can't place isn't kept.
        let mut ac = Autocorrect::default();
        ac.made("the ", 1..4, 4, "teh", "the");
        assert_eq!(type_through(&mut ac, &["teh "]), vec![]);
    }

    #[test]
    fn where_substitutions_land() {
        // "a--b teh " with a dash and a correction: the correction moves on a
        // byte, as the dash is three bytes in place of two.
        let s = vec![
            Substitution {
                range: 5..8,
                with: "the".into(),
                kind: Kind::Correction,
            },
            Substitution {
                range: 1..3,
                with: "—".into(),
                kind: Kind::Dash,
            },
        ];
        assert_eq!(ranges_after(&s), vec![6..9, 1..4]);
    }

    #[test]
    fn multibyte_edits() {
        let mut ac = Autocorrect::default();
        ac.made("hé café ", 4..9, 10, "cafe", "café");
        assert_eq!(
            type_through(&mut ac, &["hé café", "hé caf", "hé cafe"]),
            vec![reverted("cafe", "café")]
        );
    }

    #[test]
    fn link_addresses_are_skipped() {
        let text = "See [Rex names](thread:90ebc199-0d6b) and [x](y\nz) then ](done)";
        let got: Vec<&str> = link_targets(text).into_iter().map(|r| &text[r]).collect();
        assert_eq!(got, ["thread:90ebc199-0d6b", "done"]);
    }

    #[test]
    fn mid_char_offsets_do_not_panic() {
        for byte in 0..=2 {
            assert_eq!(utf16_of_byte("", byte), 0);
            assert_eq!(word_at("", byte), 0..0);
        }

        // a(0..1) sp(1..2) ע(2..4) ב(4..6) sp(6..7) 😀(7..11, 2 UTF-16) sp(11..12) ok(12..14)
        let text = "a עב 😀 ok";
        assert_eq!(utf16_of_byte(text, 3), 2);
        assert_eq!(word_at(text, 3), 2..6);
        assert_eq!(utf16_of_byte(text, 5), 3);
        assert_eq!(word_at(text, 5), 2..6);
        for mid_emoji in 8..=10 {
            assert_eq!(utf16_of_byte(text, mid_emoji), 5);
            assert_eq!(word_at(text, mid_emoji), 7..7);
        }
        assert_eq!(utf16_of_byte(text, 11), 7);
        assert_eq!(utf16_of_byte(text, text.len() + 2), 10);
        assert_eq!(word_at(text, text.len() + 2), 12..14);

        for byte in 0..=text.len() + 2 {
            let _ = utf16_of_byte(text, byte);
            let r = word_at(text, byte);
            assert!(text.is_char_boundary(r.start) && text.is_char_boundary(r.end));
        }
    }
}
