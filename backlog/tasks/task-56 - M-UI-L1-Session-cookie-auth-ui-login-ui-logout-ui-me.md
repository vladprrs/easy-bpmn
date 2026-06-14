---
id: TASK-56
title: 'M-UI-L1: Session-cookie auth (/ui/login, /ui/logout, /ui/me)'
status: Done
assignee: []
created_date: '2026-06-14 10:08'
updated_date: '2026-06-14 10:54'
labels: []
milestone: m-6
dependencies: []
priority: high
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Simplest single-operator auth: UI_USER/UI_PASS env creds → HMAC-signed ({exp}) HttpOnly+Secure+SameSite=Lax cookie via Web Crypto. /ui/login sets it, /ui/logout clears it, /ui/me returns {authenticated, workspaceId?}. New UI-namespace endpoints + SSE require the cookie; existing root endpoints stay open (contract preserved). Source: §8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 HMAC sign/verify of the session token with UI_SESSION_SECRET (Web Crypto subtle)
- [x] #2 POST /ui/login validates env creds, sets a Lax HttpOnly Secure cookie; bad creds → 401
- [x] #3 GET /ui/me returns auth state + UI_DEFAULT_WORKSPACE; POST /ui/logout clears the cookie
- [x] #4 requireSession middleware returns 401 without a valid cookie; unit + contract tests cover sign/verify and the three endpoints
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/ui/session.ts: HMAC-SHA256 sign/verify of an {exp} token via Web Crypto subtle; HttpOnly+Secure+SameSite=Lax cookie (ebpmn_session). src/ui/handlers.ts: POST /ui/login (timing-safe cred check vs UI_USER/UI_PASS → 200+Set-Cookie or 401), POST /ui/logout (204, clears cookie), GET /ui/me ({authenticated, workspaceId, authConfigured}). requireSession → 401 without a valid cookie; no-op when auth is unconfigured (open local dev). Unit (tests/unit/ui-session.test.ts: round-trip, wrong-secret, tamper, expiry, malformed) + integration (tests/integration/ui-console.test.ts auth block) GREEN.
<!-- SECTION:FINAL_SUMMARY:END -->
