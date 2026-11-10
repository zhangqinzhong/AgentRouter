# LongMemEval-S release benchmark: 3.3.0

The 3.3.0 release benchmark runs all 470 answerable LongMemEval-S questions
through the shipped hook capture pipeline. It measures the default zero-LLM
FTS path and the in-process local embedder, both with the production-default
observation stream enabled.

## Provenance

- code: both modes used `c92047ed3b5f639aab615ae4e33f3310c52c0843`,
  the frozen 3.3.0 release candidate before this report.
- dataset: `longmemeval_s`, sha256
  `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`.
- hardware: AMD Ryzen 9 7950X3D (32 threads). The two modes ran serially;
  no build or test workload overlapped the local-embedding run.
- commands, after building `ai-memory` and `ai-memory-eval` in release mode:

  ```bash
  ai-memory-eval retrieval \
    --server-bin target/release/ai-memory \
    --concurrency 6 --http-timeout-secs 900 \
    --server-env AI_MEMORY_RETRIEVAL__OBSERVATION_STREAM=true \
    --server-env AI_MEMORY_EVAL_SKIP_WIKI_CHECKPOINTS=1

  ai-memory-eval retrieval \
    --server-bin target/release/ai-memory \
    --concurrency 6 --http-timeout-secs 900 \
    --embeddings local \
    --server-env AI_MEMORY_RETRIEVAL__OBSERVATION_STREAM=true \
    --server-env AI_MEMORY_EVAL_SKIP_WIKI_CHECKPOINTS=1
  ```

- run dirs: `evals/runs/2026-10-29T21-20-20-570928323Z-retrieval` (FTS)
  and `evals/runs/2026-10-29T21-21-17-842507936Z-retrieval` (local).

## Results

FTS matches 3.2.6 exactly at every accuracy and recall cutoff. Local
embeddings keep the primary `hit@5` metric exact. Local `hit@10` and
`recall@10` each moved by 0.007, roughly three questions and just outside the
documented +/-0.005 overall noise band. The result is published rather than
re-run until favorable; #1854 tracks the per-question investigation.

| mode | hit@1 | hit@3 | hit@5 | hit@10 | recall@5 | recall@10 | p50 | p95 | mean context tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| FTS 3.2.6 | 0.857 | 0.930 | 0.951 | 0.972 | 0.893 | 0.937 | 11 ms | 73 ms | 534.8 |
| **FTS 3.3.0** | **0.857** | **0.930** | **0.951** | **0.972** | **0.893** | **0.937** | **11 ms** | **73 ms** | **534.8** |
| local 3.2.6 | 0.766 | 0.904 | 0.945 | 0.977 | 0.879 | 0.947 | 157 ms | 363 ms | 535.2 |
| **local 3.3.0** | **0.762** | **0.909** | **0.945** | **0.970** | **0.876** | **0.940** | **141 ms** | **330 ms** | **534.5** |

Local `hit@5` moved on two small slices while remaining exact overall:

| slice | n | 3.2.6 | 3.3.0 | delta |
|---|---:|---:|---:|---:|
| knowledge-update | 72 | 1.000 | 1.000 | 0.000 |
| multi-session | 121 | 0.975 | 0.975 | 0.000 |
| single-session-assistant | 56 | 0.893 | 0.893 | 0.000 |
| single-session-preference | 30 | 0.867 | 0.900 | +0.033 |
| single-session-user | 64 | 0.969 | 0.953 | -0.016 |
| temporal-reasoning | 127 | 0.913 | 0.913 | 0.000 |

## Latency and ingest

FTS query latency stayed at 11/73 ms p50/p95. Local query latency moved from
157/363 ms to 141/330 ms. FTS ingested 278,946 items in 55.2 seconds. Local
embeddings ingested the same items in 1,624.1 seconds. Ingest wall time is
load-sensitive and is not a release gate. Both runs returned zero
raw-observation fallback hits.

## Verdict

The primary retrieval gate passes: FTS is exact and local `hit@5` is exact.
The top-ten movement is small but outside the pre-registered overall noise
band, so it is published here and tracked in #1854 instead of hidden or used
to tune this release.
