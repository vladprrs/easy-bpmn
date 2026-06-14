---
id: m-6
title: "M-UI — Operator Console"
---

## Description

Read-only operator console for easy-bpmn: a React SPA served same-origin by the Worker (Cloudflare static assets), session-cookie auth, read/aggregation endpoints (projects/attention/sagas, instance jobs+attempts, message search, raw BPMN XML), an SSE history live-tail, and BPMN viewing with a live execution overlay (bpmn-js + ELK). Read-only except the existing cancel/retry controls. Inspection reads D1 only (constitution invariant). Source: docs/superpowers/specs/2026-06-14-operator-console-ui-design.md. Unblocked by constitution v2.4.0 (M-UI exclusion removed).
