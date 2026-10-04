# Retrieval Evaluation Guide

## Purpose

Retrieval changes must be proven by deterministic Evaluation rather than subjective inspection. This applies to ranking boosts, lifecycle filtering, applicability rules, chunking, and any future hybrid retrieval.

## Metrics

Knowledge retrieval cases report:

- Hit@1
- Hit@3
- Hit@5
- MRR

Evaluation also records total/pass/fail and baseline regression.

## Repository suites

Put `EVALUATION.yaml` beside the assets it protects. Knowledge cases use target `knowledge` with search/get expectations. Skill/Prompt/Agent cases can live in the same suite.

## Local run

~~~bash
npm run evaluate:repo -- \
  --path ../rd-skills \
  --id rd-skills \
  --revision working-tree
~~~

With a baseline:

~~~bash
npm run evaluate:repo -- \
  --path ../rd-skills \
  --id rd-skills \
  --revision candidate \
  --baseline-path ../rd-skills-baseline \
  --baseline-revision baseline
~~~

## CI gate

`npm run ci:evaluate` is an alias intended for CI. It exits non-zero for hard gate failure, including failed cases, regression, or removed baseline suites.

Thresholds can be configured:

~~~bash
npm run ci:evaluate -- \
  --path ../rd-skills \
  --min-pass-rate 1 \
  --min-hit-at-1 0.8 \
  --min-hit-at-3 0.95 \
  --min-hit-at-5 1 \
  --min-mrr 0.85
~~~

Warning thresholds are available separately with `--warn-*` arguments.

## Admin Web

Evaluation tab can:

- load suites from an active revision;
- choose candidate and baseline revisions;
- run a suite;
- show failed cases;
- show Hit@1/3/5 and MRR;
- display historical runs and regression state.

## Change policy

For ranking/chunking changes:

1. add or update golden cases first;
2. run the current implementation as baseline;
3. make one deterministic ranking/chunking change;
4. compare candidate vs baseline;
5. keep the change only when the Evaluation result supports it.

Do not introduce embedding/vector infrastructure solely because an anecdotal query looks weak.
