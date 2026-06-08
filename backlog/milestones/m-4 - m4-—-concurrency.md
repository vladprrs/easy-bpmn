---
id: m-4
title: "M4 — Concurrency"
---

## Description

parallelGateway split/join; concurrent token set (execution_tokens — the single current_element_id becomes one token among many); AND-join barrier; compensation correct for partially-completed parallel branches. The largest engine change (off the scalar cursor) and a CF-Workflows concurrency strategy. Source: design doc §8 (M4), §9.
