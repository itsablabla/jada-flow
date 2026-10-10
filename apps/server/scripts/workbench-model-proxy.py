"""Loopback-only, workbench-only Manifest transport. No credentials are stored."""

import httpx
import os
import json
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

app = FastAPI()


@app.get("/health")
async def health():
    return {"status": "ready", "purpose": "workbench-only", "reasoning_effort": "none"}


def without_thinking(body: bytes) -> bytes:
    """Set the Responses API policy for both authoring and Agent node requests."""
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("Request must be a JSON object")
    payload["reasoning"] = {"effort": "none"}
    return json.dumps(payload).encode()


@app.post("/v1/responses")
async def responses(request: Request):
    if request.headers.get("authorization") != "Bearer workbench":
        return Response(status_code=401)
    body = await request.body()
    if len(body) > 8 * 1024 * 1024:
        return Response(status_code=413)
    try:
        body = without_thinking(body)
    except (ValueError, TypeError):
        return Response("Invalid model request", status_code=400)
    client = httpx.AsyncClient(timeout=240)
    origin = os.environ.get("CUSTOM_CRED_APP_MANIFEST_BUILD_URL")
    token = os.environ.get("CUSTOM_CRED_APP_MANIFEST_BUILD_PROXY_AUTH_KEY")
    if not origin or not token:
        await client.aclose()
        return Response("Secure testing credential unavailable", status_code=503)
    try:
        upstream = await client.send(
            client.build_request(
                "POST",
                origin.rstrip("/") + "/v1/responses",
                content=body,
                headers={"content-type": "application/json", "x-api-key": token},
            ),
            stream=True,
        )
    except Exception:
        await client.aclose()
        return Response("Model gateway unavailable", status_code=502)

    async def stream():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        stream(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
    )
