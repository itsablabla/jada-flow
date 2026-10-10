# Jada Flow workbench status

## Scope

Jada Flow is a separate fork of OpenFlow with a native Pipali workflow-building copilot and Pipali as the actual built-in Agent runtime. Preserve upstream canvas/runtime behavior and the existing NoClick deployment.

Upstream baseline: `0fe32bb1249ecbcd76fba5700f0a87b7bf480da5`.
Fork: https://github.com/itsablabla/jada-flow
Working branch: `feat/pipali-integration`.

## Progress

- [x] Downloaded upstream and created a separate GitHub fork.
- [x] Installed pinned Bun 1.4.2 and Node 26.11.1 in workbench-local tools.
- [x] Installed dependencies using the frozen lockfile.
- [x] Record unmodified baseline check/build/unit/server/CLI results.
- [x] Add shared actual Pipali host integration.
- [x] Prove built-in Agent approval/continuation/restart behavior.
- [x] Add scoped saved-workflow authoring and native chat UI.
- [x] Add Jada Flow identity while preserving upstream attribution.
- [x] Run the scoped regression, real-provider, failure and browser checks recorded in `JADA-VERIFICATION.md`.
- [x] Verify npm and CLI package artifacts and record reproduction instructions.
- [ ] Docker container build/run/restore acceptance: blocked by missing Docker executable in this workbench.
- [x] Chat-driven public HTTPS Streamable HTTP MCP discovery, inline bearer authentication, native Agent tool binding and approval-gated execution implemented and fixture-tested. See `JADA-MCP.md`.
- [ ] Live external-provider delivery, OAuth/stdio/legacy SSE and universal MCP compatibility are not certified.

## Test inventory

| Layer             | Acceptance                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Baseline          | Upstream format/lint/types/build and package/command/server tests                        |
| Real runtime      | Actual Pipali research loop for both authoring and Agent, no disguised one-shot LLM      |
| Workflow          | Saved graph creation, executable generated code, conversational update, validation       |
| State             | Reload persistence, revision conflicts, retry idempotency, selected-node scope           |
| Agent             | Declared tools only, output schema, round/deadline budget, result references             |
| Approval          | Approve/reject, multiple pending calls, restart, no repeated side effects                |
| Safety            | Cross-user rejection, secrets absent from logs/graph, Stop, indeterminate effects        |
| Native automation | Manual, cron, webhook, branches, waits, publication/revision isolation                   |
| Browser           | Real login/create/edit/run controls, chat streams, connection prompt, dark/light/mobile  |
| Failure           | Runtime unavailable, invalid model output, revoked/missing credentials, concurrent edits |
| Distribution      | Package artifacts, source images when local container support exists                     |

Results and boundaries are in `JADA-VERIFICATION.md`. Synthetic connector/provider fixtures are not live-service certification. No real external messages or production deployment were performed.
