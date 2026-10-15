//! Local credential scrub shared by external capture clients.

use regex::Regex;
use std::sync::OnceLock;

pub fn sanitize_external_text(input: &str) -> String {
    let controls_removed: String = input
        .chars()
        .map(|ch| {
            if ch == '\n'
                || ch == '\r'
                || ch == '\t'
                || !(ch.is_control()
                    || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
            {
                ch
            } else {
                '\u{fffd}'
            }
        })
        .collect();
    secret_patterns()
        .iter()
        .fold(controls_removed, |text, rule| {
            rule.regex
                .replace_all(&text, |captures: &regex::Captures<'_>| {
                    let matched = captures.get(0).map_or("", |matched| matched.as_str());
                    if captures.get(3).is_some_and(|value| {
                        value.as_str().chars().count() < 6
                            || [
                                "[REDACTED]",
                                "[REDACTED CREDENTIAL]",
                                "[REDACTED PRIVATE KEY]",
                            ]
                            .contains(&value.as_str())
                    }) {
                        matched.to_owned()
                    } else {
                        let mut replacement = String::new();
                        captures.expand(rule.replacement, &mut replacement);
                        replacement
                    }
                })
                .into_owned()
        })
}

struct RedactionRule {
    regex: Regex,
    replacement: &'static str,
}

fn secret_patterns() -> &'static [RedactionRule] {
    static RULES: OnceLock<Vec<RedactionRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            RedactionRule {
                regex: Regex::new(
                    r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
                )
                .unwrap(),
                replacement: "[REDACTED PRIVATE KEY]",
            },
            RedactionRule {
                regex: Regex::new(
                    r"\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b",
                )
                .unwrap(),
                replacement: "[REDACTED CREDENTIAL]",
            },
            RedactionRule {
                regex: Regex::new(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}").unwrap(),
                replacement: "$1[REDACTED]",
            },
            RedactionRule {
                regex: Regex::new(
                    r#"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)\b(\s*[:=]\s*)(\"[^\"\r\n]{6,}\"|'[^'\r\n]{6,}'|(?:\[REDACTED(?: CREDENTIAL| PRIVATE KEY)?\]|[^\s,;])+)"#,
                )
                .unwrap(),
                replacement: "$1$2[REDACTED]",
            },
        ]
    })
}
