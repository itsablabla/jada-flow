# Jada Flow private workbench preview

This is the real OpenFlow workbench and Jada Pipali copilot, not a separate mockup. The preview shell is a transport and authentication adapter for a private sandboxed browser.

## Boundary

- The private port proxy must supply a trusted `X-Visitor-Id`. Never expose this gateway directly to the public internet.
- Each visitor gets a native regular user, personal token and separate demo workflow. Tokens stay server-side in `.jada/preview/visitors.sqlite`, with mode 0600.
- OpenFlow still enforces native flow ownership and authorization.
- Draft editing, code execution and Pipali Agent test runs are enabled. Publication, external trigger activation, administration and external authorization popups are disabled.
- No external application accounts are configured for preview visitors.
- Manifest inference is charged to the approved account. The workbench credential relay is temporary, not a production credential-management solution.
- The preloaded calculation is a seeded example, not a claim of model generation. Subsequent chat changes use the actual Pipali authoring engine.

## Build and start

Start the normal Jada services first, with native API on port 7301 and its configured model relay available. Do not replace or stop unrelated applications.

From `apps/server`, build using `bun run vite build --config preview.config.ts`. The static output is `dist/preview`, with entry `preview.html`.

Run `uvicorn preview-gateway:app --host 0.0.0.0 --port 7310` from `apps/server/scripts` with FastAPI and httpx installed. Deploy only `dist/preview` behind the authenticated private preview proxy. The frontend's `__PORT_7310__` marker is rewritten to a signed relative backend route at deployment.

## Acceptance inventory

- Bootstrap and reload: stable visitor workspace, no credentials in browser responses.
- Two visitors: distinct native users and flows; cross-user reads denied.
- Missing identity: rejected; admin and publication routes rejected.
- Native canvas: saved nodes, connections, source inspection and node editor.
- Copilot: plain-language edit, saved graph update, clean validation, reload persistence.
- Execution: Test Start runs Code and real Pipali Agent; visible result and engine receipt.
- Navigation: flow catalog, return to draft, run history.
- Presentation: light/dark, copilot close/reopen, desktop and mobile, opaque-origin iframe.
- Deployed proxy: actual reads, writes, model run and reload, not just a screenshot of localhost.

The earlier 3,502-test result in JADA-VERIFICATION.md predates this preview adapter. Report preview checks separately.

## Verified on October 10, 2026

- Server formatting, lint and TypeScript checks pass; production preview bundle builds.
- Gateway: missing visitor returns 401, admin and publication writes return 403, own-flow read returns 200, another visitor's flow read returns 404.
- Native Test Start through the adapter returned 43. Conversational editing changed the calculation to 19 + 25 and a subsequent native run returned 44.
- Through the deployed private proxy, a second chat edit changed the calculation to 20 + 25, with the original graph and Agent mapping retained. Test Start returned 45.
- The visible run receipt identifies `pipali/d1efc3cc315c1a0ece86ff490af9e0ff7788219d/jada-v1`, not the original Agent framework.
- Reload preserves saved graph edits and copilot history. Copilot close/reopen and theme toggles work.
- A real opaque-origin sandbox iframe loads the deployed canvas and code editor. The code editor supports a saved edit, and the run-log download succeeds without manipulating a popup.
- At 390 × 844, the composer stays inside the viewport, there is no page-level horizontal overflow, and closing/reopening the copilot switches between mobile canvas and chat.
- No page errors were observed in the tested isolated preview path.

The deployment static scanner flags the upstream optional IndexedDB/session-storage cache implementation and TypeScript's DOM declaration strings. Source inspection confirms cache storage failures preserve network results and in-memory state. Actual opaque-origin browser checks were used to verify these paths; the scanner override does not remove authentication or browser sandbox restrictions.

## Remaining limits

This is a temporary workbench preview, not a production deployment or a full-feature security certification. The model credential relay may require renewal. Docker runtime remains unverified. Generic incoming MCP attachment, external service connections, and production hosting remain separate work. Catalog persistence falls back to memory when the browser prohibits storage; workflow persistence remains in the native backend.
