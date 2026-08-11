---
module: dsh host tool-call scheduling
date: 2026-08-10
problem_type: workflow_issue
category: workflow-patterns
severity: low
title: dsh executes same-step tool calls by per-tool isConcurrencySafe — subagent calls run serially
description: dsh's agent-loop schedules sibling tool calls by a per-tool classifier; the subagent tool is not concurrency-safe, so N subagent dispatches emitted in one message still execute serially (each awaited). Verified from session logs and source.
tags:
  - dsh
  - tool-calls
  - concurrency
  - subagent
  - dispatch
  - is-concurrency-safe

applies_when:
  - Planning parallel dispatch (QC tri, parallel implement tracks) on a dsh host
  - Estimating wall-clock for multi-subagent rounds on dsh
---

# dsh same-step tool-call scheduling: subagent calls are exclusive (serial)

## Context

The Morning Star dispatch gates require N subagent invokes for N Assignments, emitted in one assistant message ("same message N=3" for QC tri). On the dsh host this emission is correct and satisfies the dispatch-completeness gate — but the calls do **not** run concurrently.

## What was observed (session log evidence)

Three QC tri `subagent` calls were emitted in one step (three callIds in the same assistant message). The log shows strict serialization: seat 2's TOOL CALL is timestamped at the exact millisecond of seat 1's TOOL RESULT (each seat ran ~4.5–5.5 min; total ≈ sum of the three).

## Root cause (dsh source, verified)

- The agent-loop tool-call scheduler (`executeToolCalls` in the agent-loop package) groups sibling calls by `ctx.tools.executionMode(exec)`:
  - `{ kind: 'parallel' }` → joins a bounded rolling pool (`maxParallelToolCalls`, default 10).
  - `{ kind: 'exclusive' }` → singleton barrier group: runs alone, awaited, next call starts after it settles.
- `executionMode` (core tools service) is **fail-closed**: a tool is parallel only if it declares `isConcurrencySafe(args)` returning exactly `true`. Missing classifier, non-`true` return, or a throw → exclusive.
- The `subagent` tool (tool-subagent package) **does not declare** `isConcurrencySafe` → every subagent call is exclusive.
- Only a few read-only tools opt in today (`read`, web search/fetch, session-query).

## Consequences

- Parallel batches (QC tri N=3, parallel implement tracks) run serially on dsh: correct results, longer wall-clock.
- `maxParallelToolCalls` does not help — it only bounds the parallel pool, not exclusive barriers.
- Background subagents (`run_in_background: true`) return immediately but **do not deliver results** to the caller (only an id); they are unsuitable for dispatches that must report back.

## Guidance

- Treat "N invokes in one message" on dsh as dispatch-complete but **serial execution**; budget wall-clock accordingly.
- For true parallelism: (a) request/patch tool-subagent to declare `isConcurrencySafe: () => true` (needs a dsh-maintainer concurrency review of subagent spawn — child sessions are isolated, but confirm no shared mutable state); or (b) use background subagents only when the caller can collect results asynchronously (e.g. reading the child session log).

## When to Apply

Any dsh-hosted iteration/plan dispatch planning; debugging "why did my parallel dispatch take N×".

## Examples

- QC tri dispatch on dsh: 3 seats × ~5 min serial ≈ 15 min (functionally correct tri).
- The omp deep-dive subagent was backgrounded and its final report was recovered from the child session log under the dsh sessions dir.
