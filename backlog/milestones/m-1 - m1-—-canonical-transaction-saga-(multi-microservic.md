---
id: m-1
title: "M1 — Canonical transaction-saga (multi-microservice)"
---

## Description

The minimal viable SAGA orchestrator and the milestone that satisfies the literal ask. Pull/external-task workers (activate/complete/fail); Service Task becomes an async wait; bpmn:transaction scope execution; compensation boundary + isForCompensation handler + association; error boundary → cancel end → cancel boundary; reverse-order scoped compensation; compensationFailed policy; operator cancel/retry verbs; saga view; widened status enums; saga ledger + compensation job lane. Single-token; NO gateways/parallel/timers. Source: design doc §3-§6, §8.
