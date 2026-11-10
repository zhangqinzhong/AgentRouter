//! Offline evidence-sufficiency and abstention evaluation.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::retrieval::dataset::{self, DatasetVariant};
use crate::retrieval::grep;
use crate::retrieval::ingest::stored_session_uuid;
use crate::retrieval::qa::{Answerability, QaArgs, QaEngine};
use crate::retrieval::query::HitContext;
use crate::retrieval::report::QaReportMeta;

const FIXTURE_VERSION: u32 = 1;
const DEFAULT_THRESHOLDS: [f64; 11] = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const LONGMEMEVAL_CONTEXTS: usize = 10;
const LONGMEMEVAL_SNIPPET_CHARS: usize = 4_000;

#[derive(clap::Args, Debug)]
pub struct AbstentionArgs {
    /// Versioned clean-room answerability fixture.
    #[arg(long, default_value = "evals/fixtures/abstention/v1.json")]
    fixtures: PathBuf,
    /// Output root; a timestamped run directory is created below it.
    #[arg(long, default_value = "evals/runs")]
    out: PathBuf,
    /// Also evaluate the pinned LongMemEval-S `*_abs` questions. The pinned
    /// dataset must already exist; this command never downloads it.
    #[arg(long)]
    longmemeval_abs: bool,
    /// Existing QA provider flags, shared with `retrieval --qa`.
    #[command(flatten)]
    qa: QaArgs,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureSet {
    version: u32,
    cases: Vec<Case>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    question: String,
    expected_verdict: Verdict,
    slice: Slice,
    evidence: Vec<Evidence>,
    #[serde(default)]
    target_evidence: Vec<String>,
    #[serde(default)]
    gold_answer: Option<String>,
    #[serde(default)]
    channels: Channels,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    path: String,
    snippet: String,
    score: f64,
    #[serde(default)]
    belief_strength: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    Answerable,
    Unanswerable,
    Conflicting,
    Partial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Slice {
    Baseline,
    Unrelated,
    HardNegative,
    Conflicting,
    Partial,
    MissingChannel,
    LongmemevalAbstention,
}

impl Slice {
    fn name(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Unrelated => "unrelated",
            Self::HardNegative => "hard_negative",
            Self::Conflicting => "conflicting",
            Self::Partial => "partial",
            Self::MissingChannel => "missing_channel",
            Self::LongmemevalAbstention => "longmemeval_abstention",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct Channels {
    fts: bool,
    vector: bool,
}

impl Default for Channels {
    fn default() -> Self {
        Self {
            fts: true,
            vector: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct Signals {
    lexical_coverage: f64,
    top_score: f64,
    top_score_margin: Option<f64>,
    score_mean: f64,
    score_stddev: f64,
    snippet_matching_term_density: f64,
    snippet_chars: usize,
    belief_mean: Option<f64>,
    belief_observations: usize,
}

#[derive(Debug, Clone, Serialize)]
struct CaseResult {
    id: String,
    expected_verdict: Verdict,
    slice: Slice,
    channels: Channels,
    signals: Signals,
    #[serde(skip_serializing_if = "Option::is_none")]
    qa: Option<QaResult>,
}

#[derive(Debug, Clone, Serialize)]
struct QaResult {
    answerability: Answerability,
    matches_expected: bool,
    answer: String,
    latency_ms: u128,
    estimated_tokens: usize,
}

#[derive(Debug, Clone, Serialize)]
struct ThresholdMetrics {
    threshold: f64,
    supported: usize,
    unsupported: usize,
    ambiguous_excluded: usize,
    predicted_answerable: usize,
    false_supported_rate: Option<f64>,
    false_abstention_rate: Option<f64>,
    coverage: f64,
}

#[derive(Debug, Serialize)]
struct SliceReport {
    cases: usize,
    thresholds: Vec<ThresholdMetrics>,
}

#[derive(Debug, Serialize)]
struct Report {
    generated_at: String,
    commit: String,
    hardware: String,
    fixture_version: u32,
    fixture_path: String,
    decision_signal: &'static str,
    binary_mapping: &'static str,
    qa_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    qa: Option<QaReportMeta>,
    qa_cases: usize,
    qa_verdict_matches: usize,
    qa_latency_p50_ms: Option<u128>,
    qa_latency_p95_ms: Option<u128>,
    seed: Option<u64>,
    cases: Vec<CaseResult>,
    thresholds: Vec<ThresholdMetrics>,
    slices: BTreeMap<String, SliceReport>,
}

pub async fn run(args: AbstentionArgs) -> Result<()> {
    let mut fixture = load_fixture(&args.fixtures)?;
    if args.longmemeval_abs {
        fixture.cases.extend(load_longmemeval_abstentions()?);
    }

    let (qa_engine, qa_status) = if args.qa.enabled {
        match QaEngine::resolve(&args.qa) {
            Ok(engine) => {
                let status = format!("enabled: {}", engine.summary());
                (Some(engine), status)
            }
            Err(error) => (None, format!("skipped: {error:#}")),
        }
    } else {
        (None, "disabled (offline zero-LLM run)".to_string())
    };

    let mut results = Vec::with_capacity(fixture.cases.len());
    for case in &fixture.cases {
        let qa = if let Some(engine) = &qa_engine {
            let contexts = case
                .evidence
                .iter()
                .map(|e| HitContext {
                    title: e.path.clone(),
                    snippet: e.snippet.clone(),
                })
                .collect::<Vec<_>>();
            let synthesized = engine.synthesize(&case.question, &contexts).await?;
            Some(QaResult {
                answerability: synthesized.answerability,
                matches_expected: answerability_matches(
                    case.expected_verdict,
                    synthesized.answerability,
                ),
                answer: synthesized.answer,
                latency_ms: synthesized.latency_ms,
                estimated_tokens: synthesized.tokens,
            })
        } else {
            None
        };
        results.push(CaseResult {
            id: case.id.clone(),
            expected_verdict: case.expected_verdict,
            slice: case.slice,
            channels: case.channels,
            signals: signals(case),
            qa,
        });
    }

    let thresholds = threshold_sweep(&results);
    let mut slices = BTreeMap::new();
    for slice in [
        Slice::Baseline,
        Slice::Unrelated,
        Slice::HardNegative,
        Slice::Conflicting,
        Slice::Partial,
        Slice::MissingChannel,
        Slice::LongmemevalAbstention,
    ] {
        let group = results
            .iter()
            .filter(|result| result.slice == slice)
            .cloned()
            .collect::<Vec<_>>();
        if !group.is_empty() {
            slices.insert(
                slice.name().to_string(),
                SliceReport {
                    cases: group.len(),
                    thresholds: threshold_sweep(&group),
                },
            );
        }
    }

    let qa_latencies = results
        .iter()
        .filter_map(|result| result.qa.as_ref().map(|qa| qa.latency_ms))
        .collect::<Vec<_>>();
    let qa_cases = qa_latencies.len();
    let qa_verdict_matches = results
        .iter()
        .filter_map(|result| result.qa.as_ref())
        .filter(|qa| qa.matches_expected)
        .count();
    let report = Report {
        generated_at: Timestamp::now().to_string(),
        commit: crate::retrieval::report::commit_sha(),
        hardware: crate::retrieval::report::hardware(),
        fixture_version: fixture.version,
        fixture_path: args.fixtures.display().to_string(),
        decision_signal: "normalized lexical query-term coverage",
        binary_mapping: "answerable=supported; unanswerable=unsupported; conflicting/partial excluded from FSR/FAR denominators",
        qa_status,
        qa: qa_engine.as_ref().map(QaEngine::report_meta),
        qa_cases,
        qa_verdict_matches,
        qa_latency_p50_ms: percentile(&qa_latencies, 0.50),
        qa_latency_p95_ms: percentile(&qa_latencies, 0.95),
        seed: None,
        cases: results,
        thresholds,
        slices,
    };

    let stamp: String = Timestamp::now()
        .to_string()
        .chars()
        .map(|c| if c == ':' || c == '.' { '-' } else { c })
        .collect();
    let run_dir = args.out.join(format!("{stamp}-abstention"));
    std::fs::create_dir_all(&run_dir)?;
    std::fs::write(
        run_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    let markdown = report_markdown(&report);
    std::fs::write(run_dir.join("report.md"), &markdown)?;
    println!("{markdown}");
    println!("run dir: {}", run_dir.display());
    Ok(())
}

fn load_fixture(path: &Path) -> Result<FixtureSet> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let fixture: FixtureSet =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    validate_fixture(&fixture)?;
    Ok(fixture)
}

fn validate_fixture(fixture: &FixtureSet) -> Result<()> {
    if fixture.version != FIXTURE_VERSION {
        bail!(
            "fixture version {} is unsupported; expected {FIXTURE_VERSION}",
            fixture.version
        );
    }
    if fixture.cases.is_empty() {
        bail!("fixture contains no cases");
    }
    let mut ids = HashSet::new();
    for case in &fixture.cases {
        if case.id.trim().is_empty() || !ids.insert(case.id.as_str()) {
            bail!("fixture ids must be nonempty and unique: `{}`", case.id);
        }
        if case.question.trim().is_empty() || case.evidence.is_empty() {
            bail!("{}: question and evidence must be nonempty", case.id);
        }
        let paths = case
            .evidence
            .iter()
            .map(|e| e.path.as_str())
            .collect::<HashSet<_>>();
        for evidence in &case.evidence {
            if evidence.path.trim().is_empty() || evidence.snippet.trim().is_empty() {
                bail!("{}: evidence path and snippet must be nonempty", case.id);
            }
            if !evidence.score.is_finite() || !(0.0..=1.0).contains(&evidence.score) {
                bail!("{}: evidence scores must be finite and in [0,1]", case.id);
            }
            if evidence
                .belief_strength
                .is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
            {
                bail!("{}: belief strength must be finite and in [0,1]", case.id);
            }
        }
        if case
            .target_evidence
            .iter()
            .any(|target| !paths.contains(target.as_str()))
        {
            bail!(
                "{}: target_evidence must name a supplied evidence path",
                case.id
            );
        }
        if case.expected_verdict == Verdict::Answerable
            && (case.target_evidence.is_empty()
                || case.gold_answer.as_deref().is_none_or(str::is_empty))
        {
            bail!(
                "{}: answerable cases need target evidence and a gold answer",
                case.id
            );
        }
    }
    Ok(())
}

fn load_longmemeval_abstentions() -> Result<Vec<Case>> {
    let variant: &'static DatasetVariant = &dataset::VARIANT_S;
    let path = Path::new(variant.default_path);
    let questions = dataset::load(path, variant).with_context(|| {
        "loading pinned LongMemEval abstentions; run `ai-memory-eval retrieval --fetch` first"
            .to_string()
    })?;
    let cases = questions
        .into_iter()
        .filter(|question| question.is_abstention())
        .map(|question| {
            let mut seen = HashSet::new();
            let sessions = question
                .haystack_session_ids
                .iter()
                .zip(&question.haystack_dates)
                .zip(&question.haystack_sessions)
                .filter(|((session_id, _), _)| seen.insert(session_id.as_str()))
                .map(|((session_id, date), turns)| {
                    (
                        stored_session_uuid(&question, session_id),
                        format!("sessions/{session_id}.md"),
                        grep::session_text(date, turns),
                    )
                })
                .collect::<Vec<_>>();
            let normalized = sessions
                .iter()
                .map(|(id, _, text)| (*id, text.to_lowercase()))
                .collect::<Vec<_>>();
            let scores = grep::rank_with_scores(
                &question.question,
                normalized.iter().map(|(id, text)| (*id, text.as_str())),
            );
            let top_score = scores.first().map(|(_, score)| *score).unwrap_or(1) as f64;
            let evidence = scores
                .into_iter()
                .take(LONGMEMEVAL_CONTEXTS)
                .filter_map(|(id, score)| {
                    let (_, path, text) =
                        sessions.iter().find(|(candidate, _, _)| *candidate == id)?;
                    Some(Evidence {
                        path: path.clone(),
                        snippet: text.chars().take(LONGMEMEVAL_SNIPPET_CHARS).collect(),
                        score: score as f64 / top_score,
                        belief_strength: None,
                    })
                })
                .collect();
            Case {
                id: format!("longmemeval-{}", question.question_id),
                question: question.question,
                expected_verdict: Verdict::Unanswerable,
                slice: Slice::LongmemevalAbstention,
                evidence,
                target_evidence: Vec::new(),
                gold_answer: None,
                channels: Channels::default(),
            }
        })
        .collect();
    Ok(cases)
}

fn content_terms(text: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "a", "an", "and", "are", "do", "does", "for", "how", "in", "is", "of", "on", "the", "to",
        "was", "what", "which", "with",
    ];
    text.split(|c: char| !c.is_alphanumeric() && c != '_')
        .map(str::to_lowercase)
        .filter(|term| term.len() > 1 && !STOP.contains(&term.as_str()))
        .collect()
}

fn signals(case: &Case) -> Signals {
    let query_terms = content_terms(&case.question)
        .into_iter()
        .collect::<HashSet<_>>();
    let snippets = case
        .evidence
        .iter()
        .flat_map(|e| content_terms(&e.snippet))
        .collect::<Vec<_>>();
    let snippet_terms = snippets.iter().cloned().collect::<HashSet<_>>();
    let matched = query_terms
        .iter()
        .filter(|term| snippet_terms.contains(*term))
        .count();
    let lexical_coverage = ratio(matched, query_terms.len()).unwrap_or(0.0);
    let matching_occurrences = snippets
        .iter()
        .filter(|term| query_terms.contains(*term))
        .count();
    let snippet_matching_term_density = ratio(matching_occurrences, snippets.len()).unwrap_or(0.0);

    let mut scores = case.evidence.iter().map(|e| e.score).collect::<Vec<_>>();
    scores.sort_by(f64::total_cmp);
    scores.reverse();
    let top_score = scores.first().copied().unwrap_or(0.0);
    let top_score_margin = scores.get(1).map(|second| top_score - second);
    let score_mean = scores.iter().sum::<f64>() / scores.len() as f64;
    let score_stddev = (scores
        .iter()
        .map(|score| (score - score_mean).powi(2))
        .sum::<f64>()
        / scores.len() as f64)
        .sqrt();
    let beliefs = case
        .evidence
        .iter()
        .filter_map(|e| e.belief_strength)
        .collect::<Vec<_>>();
    let belief_mean =
        (!beliefs.is_empty()).then(|| beliefs.iter().sum::<f64>() / beliefs.len() as f64);
    Signals {
        lexical_coverage,
        top_score,
        top_score_margin,
        score_mean,
        score_stddev,
        snippet_matching_term_density,
        snippet_chars: case
            .evidence
            .iter()
            .map(|e| e.snippet.chars().count())
            .sum(),
        belief_mean,
        belief_observations: beliefs.len(),
    }
}

fn ratio(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator != 0).then(|| numerator as f64 / denominator as f64)
}

fn answerability_matches(expected: Verdict, actual: Answerability) -> bool {
    matches!(
        (expected, actual),
        (Verdict::Answerable, Answerability::Answerable)
            | (Verdict::Unanswerable, Answerability::Insufficient)
            | (Verdict::Conflicting, Answerability::Conflicting)
            | (Verdict::Partial, Answerability::Partial)
    )
}

fn percentile(values: &[u128], quantile: f64) -> Option<u128> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = (quantile * sorted.len() as f64).ceil().max(1.0) as usize;
    sorted.get(rank - 1).copied()
}

fn threshold_sweep(cases: &[CaseResult]) -> Vec<ThresholdMetrics> {
    DEFAULT_THRESHOLDS
        .into_iter()
        .map(|threshold| {
            let supported = cases
                .iter()
                .filter(|case| case.expected_verdict == Verdict::Answerable)
                .count();
            let unsupported = cases
                .iter()
                .filter(|case| case.expected_verdict == Verdict::Unanswerable)
                .count();
            let ambiguous_excluded = cases.len() - supported - unsupported;
            let predicted_answerable = cases
                .iter()
                .filter(|case| case.signals.lexical_coverage >= threshold)
                .count();
            let false_supported = cases
                .iter()
                .filter(|case| {
                    case.expected_verdict == Verdict::Unanswerable
                        && case.signals.lexical_coverage >= threshold
                })
                .count();
            let false_abstained = cases
                .iter()
                .filter(|case| {
                    case.expected_verdict == Verdict::Answerable
                        && case.signals.lexical_coverage < threshold
                })
                .count();
            ThresholdMetrics {
                threshold,
                supported,
                unsupported,
                ambiguous_excluded,
                predicted_answerable,
                false_supported_rate: ratio(false_supported, unsupported),
                false_abstention_rate: ratio(false_abstained, supported),
                coverage: ratio(predicted_answerable, cases.len()).unwrap_or(0.0),
            }
        })
        .collect()
}

fn metric(value: Option<f64>) -> String {
    value.map_or_else(|| "undefined".into(), |v| format!("{v:.3}"))
}

fn report_markdown(report: &Report) -> String {
    let mut markdown = format!(
        "# Abstention evaluation\n\n- commit: `{}`\n- fixture: `{}` (v{})\n- cases: {}\n- QA: {}\n- binary mapping: {}\n\n",
        report.commit,
        report.fixture_path,
        report.fixture_version,
        report.cases.len(),
        report.qa_status,
        report.binary_mapping,
    );
    if report.qa_cases > 0 {
        markdown.push_str(&format!(
            "- QA verdict matches: {}/{}; latency p50/p95: {}/{} ms\n\n",
            report.qa_verdict_matches,
            report.qa_cases,
            report.qa_latency_p50_ms.unwrap_or_default(),
            report.qa_latency_p95_ms.unwrap_or_default(),
        ));
    }
    markdown.push_str("| lexical threshold | coverage | FSR | FAR | ambiguous excluded |\n");
    markdown.push_str("|---:|---:|---:|---:|---:|\n");
    for row in &report.thresholds {
        markdown.push_str(&format!(
            "| {:.1} | {:.3} | {} | {} | {} |\n",
            row.threshold,
            row.coverage,
            metric(row.false_supported_rate),
            metric(row.false_abstention_rate),
            row.ambiguous_excluded,
        ));
    }
    markdown.push_str("\nNo threshold is designated as calibrated; the table is a trade-off sweep over a small synthetic corpus.\n");
    markdown
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(id: &str, verdict: Verdict, coverage_text: &str) -> Case {
        Case {
            id: id.into(),
            question: "Which deployment port is configured?".into(),
            expected_verdict: verdict,
            slice: Slice::Baseline,
            evidence: vec![Evidence {
                path: "rules/server.md".into(),
                snippet: coverage_text.into(),
                score: 0.8,
                belief_strength: Some(0.7),
            }],
            target_evidence: if verdict == Verdict::Answerable {
                vec!["rules/server.md".into()]
            } else {
                Vec::new()
            },
            gold_answer: (verdict == Verdict::Answerable).then(|| "49374".into()),
            channels: Channels::default(),
        }
    }

    #[test]
    fn fixture_validation_rejects_duplicate_ids_and_missing_support() {
        let duplicate = FixtureSet {
            version: 1,
            cases: vec![
                case("same", Verdict::Answerable, "deployment port 49374"),
                case("same", Verdict::Unanswerable, "deployment docs"),
            ],
        };
        assert!(
            validate_fixture(&duplicate)
                .unwrap_err()
                .to_string()
                .contains("unique")
        );

        let mut missing = case("missing", Verdict::Answerable, "deployment port 49374");
        missing.target_evidence.clear();
        assert!(
            validate_fixture(&FixtureSet {
                version: 1,
                cases: vec![missing]
            })
            .unwrap_err()
            .to_string()
            .contains("target evidence")
        );
    }

    #[test]
    fn raw_signals_are_deterministic_and_belief_is_optional() {
        let supported = case(
            "supported",
            Verdict::Answerable,
            "The deployment uses configured port 49374.",
        );
        let first = signals(&supported);
        let second = signals(&supported);
        assert_eq!(first.lexical_coverage, second.lexical_coverage);
        assert!(first.lexical_coverage > 0.5);
        assert_eq!(first.belief_mean, Some(0.7));

        let mut absent = supported;
        absent.evidence[0].belief_strength = None;
        assert_eq!(signals(&absent).belief_mean, None);
    }

    #[test]
    fn threshold_metrics_preserve_undefined_denominators_and_ambiguous_cases() {
        let cases = [
            case("yes", Verdict::Answerable, "configured deployment port"),
            case("no", Verdict::Unanswerable, "deployment guide only"),
            case("partial", Verdict::Partial, "deployment port"),
        ]
        .into_iter()
        .map(|case| CaseResult {
            id: case.id.clone(),
            expected_verdict: case.expected_verdict,
            slice: case.slice,
            channels: case.channels,
            signals: signals(&case),
            qa: None,
        })
        .collect::<Vec<_>>();
        let sweep = threshold_sweep(&cases);
        assert!(sweep.iter().all(|row| row.ambiguous_excluded == 1));
        assert!(sweep.iter().all(|row| row.false_supported_rate.is_some()));
        assert!(sweep.iter().all(|row| row.false_abstention_rate.is_some()));

        let only_partial = vec![cases[2].clone()];
        assert!(
            threshold_sweep(&only_partial).iter().all(
                |row| row.false_supported_rate.is_none() && row.false_abstention_rate.is_none()
            )
        );
    }

    #[test]
    fn verdict_mapping_and_latency_percentiles_are_explicit() {
        assert!(answerability_matches(
            Verdict::Unanswerable,
            Answerability::Insufficient
        ));
        assert!(!answerability_matches(
            Verdict::Conflicting,
            Answerability::Insufficient
        ));
        assert_eq!(percentile(&[], 0.95), None);
        assert_eq!(percentile(&[30, 10, 20], 0.50), Some(20));
        assert_eq!(percentile(&[30, 10, 20], 0.95), Some(30));
    }
}
