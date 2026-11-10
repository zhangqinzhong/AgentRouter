# Query-answer context admission: draft local measurements

This receipt records measurements from the default-disabled proposal in #1684.
The maintainer accepted its configuration and response contract in the review on
#1689. It measures builder size and local execution time, not answer correctness
or provider usage.

## Provenance

- Feature base: `e7e17555efb6a95596480249598ad517ff587310`.
- Citation-validation prerequisite: `91aa3d26df4df8064b270f8d5242cfca465d08d7`.
- Candidate code: `71f9cd36015ab4a578641630714615e5b37f4768`.
- Run: 2026-10-25 UTC, Linux 6.18.55 x86_64, AMD EPYC 9V74, 9 visible logical CPUs.
- Rust: `1.95.0 (59807616e 2026-04-14)`, debug test profile, `CARGO_INCREMENTAL=0`.
- Provider/model: none. No model requests or paid evaluations.
- Fixture: `server::tests::answer_budget_measurements`; SHA-256 of that function's
  source through the following helper boundary:
  `570d36eca47aaf411461991588642fbc432124ed6800bd99c1f1fe1d81bbd6e7`.
- CSV SHA-256: `83d1ead149d3fe2c0108135ca6440fd8b29db39b872453cab918b66da4c787ed`.
- Published candidate tree equals local tested commit `bd3179ef5d89ebdc5bd71167425d821d0c6e9f5e`
  (tree `ac2c5787080eab464d7958a09ccc0c1733c64f41`).
- Both modes ran in the candidate binary. Disabled admission delegates to the
  unchanged baseline builder; this is a mode comparison, not two separately
  compiled binaries. The disabled-request regression test compares their fields.

The fixture uses 1, 10, 50 and 100 hits, each with a 240-scalar snippet, across
ASCII, pt-BR, CJK and code. Questions are either 32 bytes or 160,000 bytes. Each
mode uses 20 warmup calls and 31 timed trials of 20 calls. The CSV records per-call
p50 and p95 nanoseconds from those trials. Other builds ran on the shared host,
so these debug timings are exploratory and do not establish production latency.

## Results

The table shows the 100-hit short-question cases. Content bytes count only system
and user messages. The enabled mode also counts serialized schema bytes and 1024
envelope units, then reserves 2000 output tokens, within its 16000-unit target.
The one-byte-per-estimated-input-token contract is not a tokenizer guarantee.

| Fixture | Disabled bytes | Enabled bytes | Byte reduction | Admitted / omitted / clipped | Disabled p50 / p95 µs | Enabled p50 / p95 µs |
|---|---:|---:|---:|---|---:|---:|
| ascii | 31422 | 12156 | 61.31% | 35 / 65 / 0 | 261.37 / 270.36 | 185.12 / 200.18 |
| pt-BR | 32922 | 12191 | 62.97% | 34 / 66 / 1 | 270.66 / 291.94 | 194.16 / 228.80 |
| CJK | 79422 | 12189 | 84.65% | 15 / 85 / 1 | 728.71 / 1087.62 | 179.16 / 195.91 |
| code | 31422 | 12156 | 61.31% | 35 / 65 / 0 | 250.47 / 491.15 | 179.76 / 276.06 |

All long-question cases produced no request in the enabled mode. Their receipt
can report estimated input above the limit: it explains the refused request,
not a prompt sent to a provider. CSV `NA` means disabled mode has no input-token
estimate; it does not mean zero tokens. `content_bytes=0` with `request_built=false`
means no request was built.

The one-hit ASCII case added local work: p50 rose from 5.317 µs to 49.540 µs,
including schema sizing. Larger cases did less rendering because they omitted
sources. No overhead acceptance threshold has been agreed.

The CJK case admits only 15 of 100 sources at this conservative budget. These
measurements predate the reviewed admission policy below, which added stricter
correction ordering and clipping guards. Answer accuracy under pruning remains
unmeasured. Retrieval hits and ranking remain unchanged.

Full measurements: [CSV](query-answer-context-draft.csv).

## Historical evidence-retention result (before review changes)

`answer_budget_labeled_evidence_retention_boundaries` uses labeled English,
pt-BR, CJK and code fixtures with an exact required current-fact literal. It
checks the prompt produced by the actual builder, without a provider. Its
16 cases specify these outcomes for each language:

| Budget/order boundary | Required current-fact literal | Admission |
|---|---|---|
| Exact fit, history followed by correction in one snippet | Retained | 1 admitted, 0 omitted, 0 clipped |
| Same snippet, allowance ends before its correction | Lost | 1 admitted, 0 omitted, 1 clipped |
| Historical source first; only that source fits | Lost | 1 admitted, 1 omitted, 0 clipped |
| Current correction first; only that source fits | Retained | 1 admitted, 1 omitted, 0 clipped |

Measured on 2026-10-25 with local source commit
`94293327faa450b52d13bea584e89865c185ac56`, Rust 1.95.0, on the Linux host
described above: the disabled-mode baseline retained the required literal in
16 of 16 cases; the bounded candidate retained it in 8 of 16 cases. These are
deliberate boundary probes, not representative quality estimates or model-answer
accuracy scores. One deterministic run records baseline and candidate retention
separately for every case; it makes no provider calls.

The assertions also reconstruct input accounting from the request and schema,
check the configured bound, verify admitted/omitted citation identities, and
compare full retrieval hits before and after admission. Historical-first
fixtures mark the admitted historical source `superseded: true`; that label
does not recover an omitted correction. Lines prefixed `C2RETENTION,` report
the asserted outcomes when run with `--nocapture`.

This was a literal-retention regression, not a model answer-quality evaluation.
The two loss cases passed only when they exposed the known loss; they did not
establish acceptable pruning quality. The reviewed policy below replaced those
expectations with current-fact retention checks. No prompt-only abstention
guarantee is claimed.

```sh
cargo test -p ai-memory-mcp --lib answer_budget_labeled_evidence_retention_boundaries -- --nocapture
```

## Reproduce

```sh
cargo test -p ai-memory-mcp --lib answer_budget_measurements -- --ignored --nocapture
```

Lines beginning `C2CSV,` contain the receipt. Remove that prefix to recover the
CSV. No provider configuration is needed. The test is ignored in normal CI so
its timing loop does not become part of the everyday test run.

## Reviewed admission policy

The revised policy orders same-topic evidence by explicit supersession first,
then evidence time within the same workspace/project and normalized exact title.
Canonical session pages use session start time, so late ingestion cannot make
an older session appear newer. This is a narrow metadata-based topic rule;
prose similarity alone does not establish a topic relationship.

It first admits whole snippets, skipping items that do not fit. If a newer
correction was skipped, its known obsolete predecessor cannot consume that
allowance instead. After whole-snippet selection, unused space can hold one
complete trailing sentence or statement from an omitted snippet. Partial
sentences and unsplittable text are omitted. Unicode punctuation and code
statement boundaries are supported; this is a syntactic boundary rule, not a
language parser. Wrapped prose newlines and semicolons do not permit clipping.
Ambiguous boundaries inside abbreviations or quoted code are omitted. Ellipses
and the receipt make omissions visible.

The original sixteen literal-retention probes now require all corrections to
remain present. Additional tests cover same-topic session chronology, transitive
lineage over imported timestamps, unusable newer evidence, independent topics
and scopes, whole-snippet priority, ambiguous abbreviation and quoted-code
boundaries, and safe refusal when no complete sentence fits. These probes do not
measure model answer accuracy or prove that arbitrary omitted evidence is
irrelevant. The earlier timings and 8/16 result above remain historical
measurements.

A snippet with an incomplete trailing qualification is omitted rather than
clipped back to an earlier complete sentence; that tail might reverse the rule.
