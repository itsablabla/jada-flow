# Jada Flow: workbench verification

Verified October 10, 2026. This report describes a working workbench build, not production certification of every integration.

## Automated results

| Check                                                    | Final result                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| Root format, lint, type and module-boundary checks       | Passed                                                       |
| Public workflow/canvas/UI-contract tests                 | 2,480 passed across 200 files                                |
| CLI tests                                                | 123 passed across six files                                  |
| Server tests, including Jada additions                   | 899 passed across 73 files                                   |
| Total across the three test suites                       | **3,502 passed**                                             |
| Public npm package and isolated consumer                 | Passed                                                       |
| Deterministic Command Artifact v2 and CLI smoke          | Passed                                                       |
| Compiled Server and frontend build                       | Passed                                                       |
| Pinned Pipali setup with its own dependency installation | Passed; 599 packages installed from frozen lockfile          |
| Docker acceptance                                        | Blocked: `spawn docker ENOENT`; no container build/run claim |

The final Server run included the real Pipali recovery test, not a skipped substitute. Its model-response server and Connector action were deterministic fixtures; the engine, native database, wait system and process boundaries were real.

## Real model and browser evidence

The actual app was opened in Chromium and operated using its native controls.

- **Login:** Native administrator-token login succeeded without printing the token.
- **Workflow creation:** A real chat prompt created Manual → Code → built-in Agent nodes, saved the graph and validated it.
- **First execution:** The native Test button ran the workflow. Code returned `total: 42`; the Agent returned `output: {answer: 42}`.
- **Conversational edit:** A second prompt changed `17 + 25` to `18 + 25` while retaining node identities, connections and dynamic Agent input.
- **Second execution:** The native Test button returned `output: {answer: 43}`.
- **Engine evidence:** Agent run logs identified `pipali/d1efc3cc315c1a0ece86ff490af9e0ff7788219d/jada-v1`; the adapter invoked the actual upstream research loop, not a single substitute LLM call.
- **Missing connection:** A Slack request discovered unavailable connector configuration and paused with a question. No Slack IDs were fabricated and no message was sent.
- **Question persistence:** The pending question survived a browser reload, and its native-settings button opened the correct configuration page.
- **Stop:** A real Stop click canceled a turn; the saved workflow revision was unchanged.
- **Panel controls:** Close and reopen worked at mobile width.
- **Appearance:** Light/dark modes and 390px mobile composition were inspected. The chat composer remained within the viewport, and horizontal page overflow was not observed.

The arithmetic smoke used Manifest's real model service through temporary workbench authorization. One earlier attempt failed after temporary testing access expired; refreshing the same approved testing access restored operation. No new credential entry or production-key reset was required.

These tests do not establish universal provider compatibility or guarantee model latency. Observed native Agent durations for the two arithmetic runs were approximately 13 and 22 seconds, respectively. This implementation uses a cold isolated Pipali worker for each invocation.

## Approval and restart verification

`test/pipali-recovery.test.ts` exercised the real Pipali engine against a controlled local Responses API fixture:

1. One model response proposed two distinct approval-required tool calls.
2. The first call paused before any effect.
3. The native service/database was closed and reopened.
4. Approving the first call executed its synthetic action once.
5. The second call paused without requesting another model turn.
6. The service/database was closed and reopened again.
7. Rejecting the second call produced no second effect.
8. The same run completed, retaining its stored result receipt.

The test exposed upstream's in-memory wait-retention interval. Jada now uses an explicit zero-retention host policy for Pipali-backed runs, freezing idle waits immediately; the default policy remains unchanged for other runs.

This does not make active parallel side effects replayable. An uncertain effect remains a failure/indeterminate case, not permission to repeat it.

## Regressions caught and corrected

- TypeScript parameter properties passed transpiled tests but failed Node's strip-only execution; changed to erasable field declarations.
- Tool schemas wrapped by Mastra's standard-schema adapter required proper extraction and validation rather than treatment as raw JSON Schema.
- The workbench provider gateway needed its secure injected proxy URL and header, not unauthenticated forwarding.
- Migration tests exposed the native no-foreign-key schema convention; copilot cleanup now follows explicit Flow-owned deletion.
- The schema-version guard was updated alongside the new migration.
- Copilot middleware was scoped to its own paths so it did not lower request limits for native workflow APIs.
- Development startup no longer logs the generated administrator token.
- The copilot conversation now follows new messages without forcing a user who has scrolled upward back to the bottom.

## Scope limits

- No production deployment or change to the existing NoClick app.
- No real Slack, Telegram, Hindsight, Beeper or other business-message delivery.
- No universal external MCP attachment, arbitrary host shell access or persistent cross-run Pipali skills/memory.
- No warm-worker pool; latency and resource optimization remain separate work.
- No full independent security audit, hostile multitenant assessment, load/SLA certification or offsite disaster-recovery drill.
- Dockerfile integration is present, but the container could not be built or executed here.
- The new copilot copy is English; upstream localized controls remain available.
- Selected-node scope is enforced by the backend when explicitly supplied; automatic canvas-selection binding is not yet exposed by the host panel.
- Native fixtures cover scheduling/webhook/publication behavior; every combination with every live provider has not been exercised.

## Reproduction and operation

Read `JADA.md` for setup, worker paths and tests. `run-jada.sh` selects Pipali explicitly; bare upstream launch commands do not silently convert legacy engine configuration.

Keep credentials in the configured service or secret manager. Do not place them in Git, prompts, screenshots or test reports. The temporary workbench model proxy is testing infrastructure only.

Use isolated fixture accounts/workflows for future tests. Preserve upstream attribution and the independent NoClick deployment.
