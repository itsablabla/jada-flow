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
