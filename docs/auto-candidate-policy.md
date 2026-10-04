# Automatic Knowledge Candidate Policy

## Principle

Automatic generation reduces developer friction, but only Human Review can promote a Candidate toward Git-managed Knowledge.

## Defaul

Automatic Knowledge is enabled by default by the setup scripts.

Opt out:

~~~bash
bash scripts/setup-codex-mcp.sh --no-auto-knowledge
~~~

~~~powershell
.\scripts\setup-codex-mcp.ps1 -NoAutoKnowledge
~~~

The preference is preserved by setup upgrade unless explicitly changed.

## Detector

Current detector:

~~~tex
stop-evidence-v2
~~~

It classifies reusable results as:

- root-cause;
- verified-fix;
- workaround;
- reusable-constraint.

## Required signals

A Stop event is eligible only when the session shows a useful combination of:

- engineering action;
- structured passing Evidence;
- a sufficiently informative final result;
- reusable engineering content.

## Skip rules

The detector records a reason when it skips generation. Important reasons include:

- no engineering action;
- no strong test Evidence;
- final summary too short;
- low-reuse-value summary;
- exact/near/template duplicate;
- Candidate already generated;
- session/user rate limit;
- Stop-hook recursion.

## Duplicate and relation handling

Candidate dedupe has two layers:

- exact fingerprint -> `duplicateOf`;
- deterministic near duplicate -> `possibleDuplicateOf` + similarity.

High-confidence near duplicates generated automatically are skipped. Manually submitted similar Candidates remain reviewable and receive a warning.

The detector may suggest `updates`, `supersedes`, `conflicts_with`, or `related_to`. A Reviewer must confirm the final relation.

## Safety boundary

Automatic Candidates:

- remain `pending`;
- never auto-approve;
- never auto-merge;
- never bypass GitLab MR review;
- retain Evidence and detector reasoning for audit.
