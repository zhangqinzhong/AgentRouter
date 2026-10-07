//! FTS5 `MATCH` query preparation for user/agent-supplied search text.
//!
//! FTS5 treats `column:term` as a column-qualified search. Natural-language
//! queries that contain bare colons (`pick: handoff`, `memory: bootstrap`) make
//! SQLite error with `no such column: pick` because only `title` and `body`
//! exist on the FTS tables. Unknown bare column syntax is neutralised without
//! discarding deliberate FTS operators such as `OR`.

use std::collections::HashSet;
use std::sync::Arc;

/// Built-in English stopwords excluded from bare-query OR-joins when the
/// operator has not configured `[search.fts] stopwords` at all (issue #953).
/// Deliberately small and boring: high-document-frequency function words
/// that carry no retrieval signal but dominate BM25 through term frequency.
/// This is exactly the list `is_stopword` matched against before the
/// filter became configurable, so an install that never touches
/// `[search.fts]` sees byte-identical behaviour.
pub const DEFAULT_STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did", "do",
    "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me",
    "my", "of", "on", "or", "our", "she", "should", "so", "that", "the", "their", "them", "they",
    "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
    "with", "would", "you", "your",
];

/// Normalized stopword set used to filter bare natural-language FTS queries
/// before the OR-join (see [`prepare_fts5_query`]).
///
/// Construction folds every entry to lowercase with [`str::to_lowercase`]
/// (full Unicode case folding, not ASCII-only) so callers never have to
/// pre-normalize a configured list, and comparison at match time folds the
/// query token the same way. This matters specifically for the non-English
/// installs this feature targets: the FTS content index itself is
/// `unicode61 remove_diacritics 2`, so a page body indexes "É"/"é"/"e" as
/// the same posting — an ASCII-only fold would make this filter weaker than
/// the index it feeds, missing a sentence-initial "É" or an all-caps "NÃO"
/// entirely. Folding does NOT strip diacritics, though: "à" and "a" stay
/// distinct tokens here (unlike in the content index), because that would
/// silently change the built-in English default (no accented entries) and
/// because a stopword list should say precisely which spelling to drop.
/// Concretely: what matters for this filter is how a query is actually
/// TYPED, not how wiki content is spelled — content matches through the
/// diacritic-folded index regardless, but a bare query's raw characters are
/// all this filter ever sees. A configured list for an accented language
/// should include both the accented and unaccented forms a user or agent
/// might type (e.g. Portuguese `"e"` and `"é"`, `"nao"` and `"não"`).
///
/// Also note the filter runs on `raw.split_whitespace()` tokens, before any
/// punctuation handling — an entry never matches a token with attached
/// punctuation (`"de,"`, `"que?"`), the same limitation the built-in English
/// list has always had (`"the,"` was never filtered either).
///
/// Cheap to clone (an `Arc`-shared set) so it can be threaded through a
/// `'static` closure (e.g. `ReaderPool::with_conn`) without re-hashing the
/// list on every search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FtsStopwords(Arc<HashSet<String>>);

impl FtsStopwords {
    /// Build from an explicit list of words, already validated by the
    /// caller (`ai-memory-cli`'s `Config::load` bounds list size and entry
    /// length for `search.fts.stopwords`, issue #953). Entries are folded
    /// to lowercase here (see the struct doc for the exact fold) so this is
    /// the single place normalization happens.
    #[must_use]
    pub fn new<I, S>(words: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        Self(Arc::new(
            words
                .into_iter()
                .map(|w| w.as_ref().to_lowercase())
                .collect(),
        ))
    }

    /// No filtering at all: every token survives the OR-join. This is what
    /// an explicit `stopwords = []` in `config.toml` selects.
    #[must_use]
    pub fn none() -> Self {
        Self(Arc::new(HashSet::new()))
    }

    fn contains(&self, lowercased_token: &str) -> bool {
        self.0.contains(lowercased_token)
    }
}

impl Default for FtsStopwords {
    /// The built-in English list — an absent `[search.fts] stopwords` key
    /// resolves to this, so behaviour is unchanged for every existing
    /// install.
    fn default() -> Self {
        Self::new(DEFAULT_STOPWORDS.iter().copied())
    }
}

/// Sanitize free-text for use in `WHERE pages_fts MATCH ?`.
///
/// Returns an empty string when `raw` is empty/whitespace-only; callers
/// should skip the SQL query in that case.
///
/// Bare multi-word queries are joined with **`OR`**, not the FTS5 default
/// (`AND`). A natural-language query like "cross project search strategy"
/// otherwise requires every word to co-occur in one page — near-zero recall
/// for anything but single keywords. With `OR` + bm25 ranking (callers
/// `ORDER BY rank`), the best-matching pages still surface first. When the
/// caller supplies explicit FTS5 syntax (`OR` / `AND` / `NOT` / `NEAR` /
/// quoted phrases / parens) we preserve it verbatim instead.
///
/// `stopwords` is the operator-configured set (default: [`FtsStopwords::default`],
/// the built-in English list; `FtsStopwords::none()` disables filtering).
#[must_use]
pub fn prepare_fts5_query(raw: &str, stopwords: &FtsStopwords) -> String {
    let explicit_syntax = raw.contains('"')
        || raw.contains('(')
        || raw.contains(')')
        || raw
            .split_whitespace()
            .any(|t| matches!(t, "OR" | "AND" | "NOT" | "NEAR"));
    let tokens: Vec<String> = raw
        .split_whitespace()
        // Bare natural-language queries drop stopwords before the
        // OR-join: with no tokenizer-level stopword list, "the/of/a"
        // match nearly every page and BM25 term frequency lets a page
        // with five "the"s outrank the page whose CONTENT matches (seen
        // live: a release-procedure page beaten for a deploy question).
        // Explicit-syntax queries and quoted phrases are untouched, and
        // a query that is ONLY stopwords keeps them all — returning the
        // user's literal terms beats returning nothing. The active list is
        // operator-configured (`[search.fts] stopwords`, issue #953): the
        // built-in English list by default, a custom list for non-English
        // installs, or none at all. Comparison folds Unicode case (matching
        // `FtsStopwords`'s own fold) but never strips diacritics.
        .filter(|t| explicit_syntax || !stopwords.contains(&t.to_lowercase()))
        .flat_map(prepare_fts5_token)
        .collect();
    let tokens = if tokens.is_empty() && !explicit_syntax {
        raw.split_whitespace()
            .flat_map(prepare_fts5_token)
            .collect()
    } else {
        tokens
    };
    if tokens.is_empty() {
        return String::new();
    }
    let separator = if explicit_syntax { " " } else { " OR " };
    let candidate = tokens.join(separator);
    // Natural language trips the explicit-syntax path constantly — `(MoMA)`,
    // `'quoted phrases'`, a sentence that happens to contain OR — and a
    // preserved-verbatim mix can be grammatically invalid FTS5 (a quoted
    // OR-group adjacent to a bare term has no implicit AND, for one). The
    // MATCH must never error on user text, so validate the candidate against
    // a real FTS5 parser and degrade to the always-valid quoted bag of words
    // when it does not parse. Deliberate, well-formed operator queries pass
    // validation and are preserved.
    if fts5_query_parses(&candidate) {
        return candidate;
    }
    raw.split_whitespace()
        .flat_map(|token| {
            // Re-tokenize with every operator neutralised: strip quotes and
            // parens, then quote what remains.
            let cleaned: String = token
                .chars()
                .map(|c| if matches!(c, '"' | '(' | ')') { ' ' } else { c })
                .collect();
            cleaned
                .split_whitespace()
                .map(quote_fts5_token)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Whether FTS5's own parser accepts `query`. Uses a throwaway in-memory
/// table (microseconds; search-path frequency, not ingest-path) so the
/// judgement is the engine's, not a re-implementation of its grammar.
fn fts5_query_parses(query: &str) -> bool {
    thread_local! {
        // One probe connection per thread: opening a fresh in-memory
        // database per search query was measurable overhead on the
        // read-pool hot path (post-audit nit).
        static PROBE: Option<rusqlite::Connection> = {
            let conn = rusqlite::Connection::open_in_memory().ok();
            if let Some(c) = &conn
                && c.execute_batch("CREATE VIRTUAL TABLE fts_probe USING fts5(title, body)")
                    .is_err()
            {
                None
            } else {
                conn
            }
        };
    }
    PROBE.with(|probe| {
        probe.as_ref().is_some_and(|conn| {
            conn.query_row(
                "SELECT count(*) FROM fts_probe WHERE fts_probe MATCH ?1",
                [query],
                |row| row.get::<_, i64>(0),
            )
            .is_ok()
        })
    })
}

fn prepare_fts5_token(token: &str) -> Vec<String> {
    if has_unknown_bare_column(token) {
        return token
            .replace(':', " ")
            .split_whitespace()
            .map(quote_fts5_token)
            .collect();
    }

    if should_quote_fts5_token(token) {
        vec![quote_fts5_token(token)]
    } else {
        vec![token.to_string()]
    }
}

fn has_unknown_bare_column(token: &str) -> bool {
    token.contains(':')
        && !token.contains('"')
        && !token.starts_with("title:")
        && !token.starts_with("body:")
}

fn should_quote_fts5_token(token: &str) -> bool {
    if token.starts_with('"') && token.ends_with('"') {
        return false;
    }
    // Quote any token carrying ASCII punctuation so FTS5 treats it as a literal
    // phrase instead of erroring on its query grammar — e.g. a filename like
    // `current.md` otherwise yields `fts5: syntax error near "."`. A trailing
    // `*` (the FTS5 prefix operator) is allowed through bare; accented letters
    // and digits are unicode (not ASCII punctuation) so recall keeps accents.
    let core = token.strip_suffix('*').unwrap_or(token);
    // `:` is column syntax (handled by `has_unknown_bare_column`, or preserved
    // for known `title:`/`body:` columns) — it must not trigger quoting here.
    core.chars().any(|c| c.is_ascii_punctuation() && c != ':')
}

fn quote_fts5_token(token: &str) -> String {
    // FTS5 escapes `"` by doubling it. A token carrying a literal quote is an
    // explicit-phrase fragment — keep the simple escaped form (don't expand it).
    if token.contains('"') {
        return format!("\"{}\"", token.replace('"', "\"\""));
    }
    // Otherwise emit BOTH the whole token and a punctuation-stripped sub-token
    // phrase, OR'd, because the content tokenizer and the path index disagree
    // on punctuation:
    //   tokenize = "unicode61 remove_diacritics 2 tokenchars '/_-'"
    // keeps `/ _ -` INSIDE tokens (so a body mention of `ai-memory` indexes as
    // the single token `ai-memory`), while `ops::path_search_text` pre-expands
    // `/ . - _` to spaces in the path index (so a path `ui-refresh-…` indexes
    // the sub-tokens `ui`, `refresh`, …). `.` is a separator either way.
    // Neither form alone matches both: `"ai-memory"` matches the content token
    // but not the split path index; `"ai memory"` matches the path but not the
    // content token. OR-ing the two makes a search for `ai-memory` / `ui-refresh`
    // hit whichever surface indexed it. (Quoting both also neutralises the
    // punctuation that would otherwise be FTS5 query grammar — the original
    // `current.md` → `syntax error` bug.) With no punctuation the two coincide
    // and we emit a single phrase.
    let split = token
        .chars()
        .map(|c| if c.is_ascii_punctuation() { ' ' } else { c })
        .collect::<String>();
    let split = split.split_whitespace().collect::<Vec<_>>().join(" ");
    if split.is_empty() || split == token {
        format!("\"{token}\"")
    } else {
        format!("(\"{token}\" OR \"{split}\")")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every pre-#953 test called `prepare_fts5_query(raw)` against the
    /// built-in English list; this keeps that call shape so the existing
    /// test bodies below are unchanged (default list reproduces current
    /// behaviour exactly).
    fn prepare_fts5_query(raw: &str) -> String {
        super::prepare_fts5_query(raw, &FtsStopwords::default())
    }

    /// The engine, not this module, is the judge of validity: every
    /// prepared query must MATCH without error on a real FTS5 table.
    fn assert_parses(prepared: &str) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(title, body)")
            .unwrap();
        let res = conn.query_row(
            "SELECT count(*) FROM t WHERE t MATCH ?1",
            [prepared],
            |row| row.get::<_, i64>(0),
        );
        assert!(res.is_ok(), "FTS5 rejected {prepared:?}: {res:?}");
    }

    /// Regression (found by the LongMemEval harness): a natural-language
    /// question containing parens and apostrophe-quotes tripped the
    /// explicit-syntax path and produced invalid FTS5 — `fts5: syntax
    /// error near "OR"` — failing the whole memory_query call.
    #[test]
    fn natural_language_with_parens_and_quotes_never_errors() {
        let raw = "How many days passed between my visit to the Museum of \
                   Modern Art (MoMA) and the 'Ancient Civilizations' exhibit \
                   at the Metropolitan Museum of Art?";
        let prepared = prepare_fts5_query(raw);
        assert_parses(&prepared);
        // and the degraded form still carries the searchable words
        assert!(prepared.contains("MoMA"));
        assert!(prepared.contains("Civilizations"));
    }

    #[test]
    fn hostile_operator_soup_never_errors() {
        for raw in [
            "((",
            "\"unclosed phrase",
            "NEAR(",
            "OR",
            "a OR",
            "OR b",
            "NOT",
            ") misplaced (",
            "col:val:col ( OR \" NEAR",
            "\"\"\"",
        ] {
            let prepared = prepare_fts5_query(raw);
            if !prepared.is_empty() {
                assert_parses(&prepared);
            }
        }
    }

    #[test]
    fn deliberate_well_formed_syntax_is_preserved() {
        let prepared = prepare_fts5_query("title:handoff OR body:deploy");
        assert_parses(&prepared);
        assert_eq!(prepared, "title:handoff OR body:deploy");
        // Quoted phrases were re-tokenized into escaped-quote form long
        // before the validation fallback existed; the contract here is
        // "still valid FTS5 with AND preserved", not byte identity.
        let phrase = prepare_fts5_query("\"exact phrase\" AND deploy");
        assert_parses(&phrase);
        assert!(phrase.contains(" AND deploy"), "{phrase}");
    }

    #[test]
    fn colon_is_not_column_syntax() {
        // Bare multi-word → OR-joined (no explicit operator present).
        // `ai-memory` expands to BOTH the whole token (matches content) and
        // the sub-token phrase (matches the split path index) — see
        // `quote_fts5_token`.
        let q = prepare_fts5_query("pick: handoff ai-memory");
        assert_eq!(q, "\"pick\" OR handoff OR (\"ai-memory\" OR \"ai memory\")");
    }

    #[test]
    fn bare_multi_word_is_or_joined() {
        // The recall fix: every word no longer has to co-occur.
        assert_eq!(
            prepare_fts5_query("cross project search strategy"),
            "cross OR project OR search OR strategy"
        );
    }

    #[test]
    fn portuguese_accented_terms_or_join_and_keep_accents() {
        // PT natural-language query: tokens preserved (accents intact),
        // joined with OR so a page matching any term is found.
        assert_eq!(
            prepare_fts5_query("descrição testes commits"),
            "descrição OR testes OR commits"
        );
    }

    #[test]
    fn single_word_has_no_or() {
        assert_eq!(prepare_fts5_query("handoff"), "handoff");
    }

    /// Regression: a filename like `current.md` used to pass through bare and
    /// FTS5 errored with `syntax error near "."`. Quoting it as a phrase both
    /// avoids the error and matches `architecture-current.md` (the tokens
    /// `current` + `md` are adjacent in the indexed path).
    #[test]
    fn dotted_filename_token_is_quoted() {
        // Whole token OR sub-token phrase. The split form (`current md`)
        // matches the tokenised path; the whole form covers content tokens.
        assert_eq!(
            prepare_fts5_query("current.md"),
            "(\"current.md\" OR \"current md\")"
        );
        assert_eq!(
            prepare_fts5_query("00-index.md"),
            "(\"00-index.md\" OR \"00 index md\")"
        );
        assert_eq!(
            prepare_fts5_query("a/b/c.md"),
            "(\"a/b/c.md\" OR \"a b c md\")"
        );
    }

    /// Regression for the live-found bug: searching `ui-refresh` returned
    /// nothing even though `follow-ups/ui-refresh-scroll-restoration.md`
    /// exists. The old quoting produced `"ui-refresh"`, which FTS5 does NOT
    /// match against the indexed `ui refresh`; the sub-token phrase
    /// `"ui refresh"` does. See the real-FTS5 test in `ops.rs`.
    #[test]
    fn hyphenated_token_quotes_as_subtoken_phrase() {
        assert_eq!(
            prepare_fts5_query("ui-refresh"),
            "(\"ui-refresh\" OR \"ui refresh\")"
        );
        assert_eq!(
            prepare_fts5_query("scroll-restoration"),
            "(\"scroll-restoration\" OR \"scroll restoration\")"
        );
    }

    /// The FTS5 prefix operator (`term*`) must survive — a trailing `*` is not
    /// quoted away.
    #[test]
    fn prefix_star_token_stays_bare() {
        assert_eq!(prepare_fts5_query("curr*"), "curr*");
    }

    #[test]
    fn empty_yields_empty() {
        assert_eq!(prepare_fts5_query("   "), "");
    }

    #[test]
    fn quote_emits_whole_and_subtoken_phrase() {
        // Punctuated identifier → both forms OR'd.
        assert_eq!(
            quote_fts5_token("ai-memory"),
            r#"("ai-memory" OR "ai memory")"#
        );
        // A literal-quote fragment keeps the simple escaped form (no expansion).
        assert_eq!(quote_fts5_token(r#"say "hello""#), r#""say ""hello""""#);
        // No punctuation → single phrase.
        assert_eq!(quote_fts5_token("handoff"), r#""handoff""#);
    }

    #[test]
    fn boolean_operators_are_preserved() {
        assert_eq!(prepare_fts5_query("quick OR slow"), "quick OR slow");
    }

    /// AND is the FTS5 default but operators can be explicit — when the
    /// caller writes one, the OR-join must NOT mangle it into
    /// `foo OR AND OR bar`. Same for NOT and NEAR. (The escape hatch from
    /// the broad-recall default is what makes the OR-join safe to land.)
    #[test]
    fn explicit_and_operator_is_preserved() {
        assert_eq!(prepare_fts5_query("foo AND bar"), "foo AND bar");
    }

    #[test]
    fn explicit_not_operator_is_preserved() {
        assert_eq!(prepare_fts5_query("foo NOT bar"), "foo NOT bar");
    }

    #[test]
    fn explicit_near_operator_is_preserved() {
        assert_eq!(prepare_fts5_query("foo NEAR bar"), "foo NEAR bar");
    }

    /// A query containing a quoted phrase is treated as explicit FTS5
    /// syntax — `"exact phrase" baz` must not become
    /// `"exact" OR "phrase" OR baz` (which destroys the phrase semantics).
    /// The exact assertion is "space-joined, not OR-joined"; what the
    /// individual tokens look like after `prepare_fts5_token` is a
    /// separate concern (and unchanged from pre-#58 behaviour).
    #[test]
    fn quoted_phrase_query_is_not_or_joined() {
        let q = prepare_fts5_query("\"exact phrase\" baz");
        assert!(
            !q.contains(" OR "),
            "explicit quoted-phrase query must not get OR-joined; got {q}"
        );
    }

    /// Same escape-hatch logic for parenthesised sub-expressions —
    /// `(foo OR bar) AND baz` must survive unmangled.
    #[test]
    fn parenthesised_query_is_not_or_joined() {
        let q = prepare_fts5_query("(foo OR bar) AND baz");
        assert!(
            !q.contains("OR (foo"),
            "parens detection must skip OR-join entirely; got {q}"
        );
        assert!(
            q.contains("AND"),
            "explicit AND inside parens query must survive; got {q}"
        );
    }

    #[test]
    fn known_columns_are_preserved() {
        assert_eq!(prepare_fts5_query("title:handoff"), "title:handoff");
    }

    // --- issue #953: configurable stopword list -----------------------

    /// A custom (Portuguese) list filters the words on that list, but never
    /// touches the English words that are not on it — a Portuguese config
    /// does not accidentally strip English content out of a mixed-language
    /// corpus.
    #[test]
    fn custom_list_filters_configured_words_not_english_ones() {
        let pt = FtsStopwords::new([
            "o", "a", "os", "as", "de", "da", "do", "em", "uma", "um", "com", "para", "que", "se",
            "no", "na",
        ]);
        assert_eq!(
            super::prepare_fts5_query("o teste de integração", &pt),
            "teste OR integração"
        );
        // English stopwords are untouched by the pt list.
        assert_eq!(
            super::prepare_fts5_query("the deploy of the release", &pt),
            "the OR deploy OR of OR the OR release"
        );
    }

    /// `stopwords = []` (`FtsStopwords::none()`) disables filtering
    /// entirely: every bare token, English or not, survives the OR-join.
    #[test]
    fn empty_list_disables_filtering() {
        let none = FtsStopwords::none();
        assert_eq!(
            super::prepare_fts5_query("the of and search", &none),
            "the OR of OR and OR search"
        );
    }

    /// The only-stopwords escape hatch (returning the user's literal terms
    /// beats returning nothing) holds for a custom list too, not just the
    /// built-in English one.
    #[test]
    fn only_configured_stopwords_query_keeps_its_terms() {
        let pt = FtsStopwords::new(["o", "a", "de"]);
        assert_eq!(super::prepare_fts5_query("o a de", &pt), "o OR a OR de");
    }

    /// Explicit FTS5 syntax bypasses the configured filter exactly as it
    /// bypasses the default one.
    #[test]
    fn explicit_syntax_bypasses_custom_list_too() {
        let pt = FtsStopwords::new(["o", "de"]);
        assert_eq!(super::prepare_fts5_query("o AND de", &pt), "o AND de");
    }

    /// Worked example from the issue / docs: a Portuguese natural-language
    /// question, filtered against a Portuguese stopword list, keeps only the
    /// content words (OR-joined) and preserves their accents — the
    /// stopword comparison is ASCII-lowercase, never diacritic-stripping.
    #[test]
    fn portuguese_stopword_list_worked_example() {
        let pt = FtsStopwords::new([
            "o", "a", "os", "as", "de", "da", "do", "em", "uma", "um", "com", "para", "que", "se",
            "no", "na", "e", "é",
        ]);
        assert_eq!(
            super::prepare_fts5_query("o que fazer quando o teste de integração falha no CI", &pt),
            "fazer OR quando OR teste OR integração OR falha OR CI"
        );
    }

    /// Stopword comparison folds full Unicode case (`str::to_lowercase`, not
    /// ASCII-only) but never strips diacritics. A capitalized or all-caps
    /// accented query token still matches a lowercase configured entry
    /// (sentence-initial "É", all-caps "NÃO"), because the content FTS index
    /// itself is `unicode61 remove_diacritics 2` and this filter would
    /// otherwise be weaker than the index for exactly the languages this
    /// feature targets. But an accent is never folded away: "e" and "é"
    /// stay distinct tokens, so a list must spell out every form a user
    /// might actually type.
    #[test]
    fn stopword_comparison_is_unicode_case_insensitive_but_keeps_diacritics() {
        let pt = FtsStopwords::new(["é", "não"]);
        // Sentence-initial capital + accent still matches the lowercase entry.
        assert_eq!(super::prepare_fts5_query("É teste", &pt), "teste");
        // An all-caps accented entry in the query also folds and matches.
        assert_eq!(super::prepare_fts5_query("NÃO teste", &pt), "teste");
        // "e" (no accent) is a different token entirely and is not filtered
        // by an "é" entry — diacritics are never stripped, only case is folded.
        assert_eq!(super::prepare_fts5_query("e teste", &pt), "e OR teste");
    }
}
