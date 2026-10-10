# Jada Flow

Jada Flow is a separate fork of [OpenFlow](https://github.com/oomol-lab/open-flow) with a native Pipali authoring panel and an adapter for the existing Agent Task. It retains OpenFlow's canvas, versioned workflow storage, approval gates, connector authority and isolated JavaScript execution.

## Start locally

Use Node 26 and Bun 1.4.2, then:

```sh
bun install --frozen-lockfile
bash apps/server/scripts/setup-pipali.sh
# Configure OPEN_FLOW_LLM_ORIGIN and OPEN_FLOW_LLM_TOKEN securely.
# The origin is a root URL, without /v1; node models are explicit.
bash apps/server/scripts/run-jada.sh
```

The UI runs on localhost:7300 and its API on localhost:7301. The generated local operator token is in `apps/server/.open-flow-dev/operator-token`; it is not printed. Do not commit that directory.

`run-jada.sh` selects Pipali explicitly. Accepted Agent runs store the engine selection with their provider snapshot; an existing Mastra run does not silently switch engines. `JADA_AGENT_ENGINE=mastra` is an explicit compatibility mode, not an error fallback. Plain LLM and AI Decision tasks retain their upstream provider contracts.

The host starts a private Bun child process for each invocation. Both authoring and Agent execution invoke the pinned Pipali `research()` loop; only declared host tools are available. This first implementation uses cold workers, not a warm conversation pool.

## Using the copilot

Create or open a Flow. Describe the desired automation in the Pipali panel, then inspect the saved nodes, code and mappings on the native canvas. Chat can read schemas, discover configured connector actions, edit drafts and validate revisions.

Chat cannot publish, activate schedules, run workflows, create credentials or approve business actions. Use native connection settings and native Test/Publish controls. Questions and partial drafts persist; after a restart an interrupted authoring turn is reported honestly rather than automatically replayed.

Native Code Tasks implement generated missing logic. The Agent uses only declared Connector tools, result readers and optional isolated `run_code`. Chat-driven public HTTPS MCP attachment with optional bearer authentication is implemented through a workflow-scoped connector adapter; see `JADA-MCP.md` for security, testing and protocol limits. Arbitrary shell execution, package self-installation and shared persistent Pipali memories are not implemented.

## Approval and recovery

Pipali's adapter returns native completed/suspended outcomes, preserves exact pending arguments and model-batch call IDs, and stores completed tool-result receipts. Output correction cannot call tools.

Pipali-backed runs select zero idle-wait retention, freezing a quiescent waiting run immediately instead of keeping its continuation in memory for the upstream default interval. Active parallel side effects are not made replayable by this setting. An uncertain or interrupted active effect must still fail closed or become indeterminate; no exactly-once delivery guarantee is claimed.

The checkpoint format is pinned to the Pipali source revision and Jada adapter version. Incompatible checkpoints must not be replayed under a different engine.

## Tests

```sh
bun run check
bun run --filter @oomol-lab/open-flow test
bun run --filter @oomol-lab/open-flow-command test
bun run --cwd apps/server test
bun run test:package
```

Real engine recovery tests require these non-secret paths:

```sh
export JADA_PIPALI_SOURCE="$PWD/.jada/pipali"
export JADA_PIPALI_WORKER="$PWD/apps/server/scripts/pipali-worker.ts"
export JADA_BUN_BIN="$(command -v bun)"
```

Then run `test/pipali-recovery.test.ts` through the Server's Vitest configuration with Node's `--no-node-snapshot` flag. It uses the real Pipali engine, a deterministic local model-response fixture and a synthetic Connector; it tests native database closure/reopening across approve/reject boundaries without any real messages.

`pipali-live-smoke.ts` is an additional opt-in workbench test against the loopback model gateway on port 7302. `workbench-model-proxy.py` accepts only a synthetic loopback credential and uses securely injected temporary testing access. It is not permanent provider infrastructure and is not started by the Docker image.

## Distribution and boundaries

The Dockerfile includes Bun, the pinned patched Pipali source and the worker. Build the image from this fork; pulling upstream's image does not include Jada integration. Container execution must be verified where a Docker daemon is available; source build success alone is not that verification.

Preserve `LICENSE`, `NOTICE` and upstream source history. The embedded Pipali checkout is Apache-2.0 and retains its license; `patches/pipali-host.patch` records Jada's narrow host extension. No NoClick-derived source or production credentials are included.

The existing NoClick deployment is independent and must not be changed by Jada setup, tests or deployment.
