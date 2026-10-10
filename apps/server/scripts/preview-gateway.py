"""Private-proxy-only preview access. Each trusted visitor gets a native regular user."""

import asyncio
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

ROOT = Path(__file__).resolve().parents[3]
STATE = ROOT / ".jada" / "preview"
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
DB = sqlite3.connect(STATE / "visitors.sqlite")
os.chmod(STATE / "visitors.sqlite", 0o600)
DB.execute("CREATE TABLE IF NOT EXISTS visitors (visitor TEXT PRIMARY KEY, user_id TEXT, email TEXT, password TEXT, token TEXT, flow_id TEXT)")
DB.commit()
UPSTREAM = "http://127.0.0.1:7301"
LOCKS = {}
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allow_headers=["content-type", "idempotency-key", "x-visitor-id", "accept", "if-none-match"], expose_headers=["content-disposition", "etag"])


def visitor(request: Request) -> str:
    # Supplied by the authenticated private port proxy, not Origin or a URL parameter.
    value = request.headers.get("x-visitor-id")
    if not value or len(value) > 512:
        raise HTTPException(401, "Open this preview through its private preview link.")
    return hashlib.sha256(value.encode()).hexdigest()


async def checked(client, method, path, *, headers=None, payload=None):
    response = await client.request(method, UPSTREAM + path, headers=headers, json=payload)
    if response.status_code >= 400:
        raise HTTPException(503, f"Native preview setup failed at {path.split('/')[1]} ({response.status_code}).")
    return response


async def session(identity):
    async with LOCKS.setdefault(identity, asyncio.Lock()):
        row = DB.execute("SELECT user_id,email,password,token,flow_id FROM visitors WHERE visitor=?", (identity,)).fetchone()
        async with httpx.AsyncClient(timeout=45) as client:
            if row is None:
                if DB.execute("SELECT COUNT(*) FROM visitors").fetchone()[0] >= 20:
                    raise HTTPException(429, "Preview visitor capacity reached.")
                operator = (ROOT / "apps/server/.open-flow-dev/operator-token").read_text().strip()
                email = f"jada-preview-{identity[:24]}@preview.invalid"
                created = await checked(client, "POST", "/auth/users", headers={"authorization": f"Bearer {operator}"}, payload={"email": email, "role": "user", "version": 1})
                data = created.json()
                row = (data["user"]["userId"], email, data["password"], None, None)
                DB.execute("INSERT INTO visitors VALUES (?,?,?,?,?,?)", (identity, *row))
                DB.commit()
            user_id, email, password, token, flow_id = row
            if not token:
                await checked(client, "POST", "/auth/user-session", payload={"email": email, "password": password, "version": 1})
                issued = await checked(client, "POST", "/auth/tokens", payload={"name": "Private Jada preview", "version": 1})
                token = issued.json()["token"]
                DB.execute("UPDATE visitors SET token=?,password=NULL WHERE visitor=?", (token, identity))
                DB.commit()
            headers = {"authorization": f"Bearer {token}"}
            if not flow_id:
                created = await checked(client, "POST", "/v1/flows", headers={**headers, "idempotency-key": f"preview-{identity}"}, payload={"name": "Jada demo", "version": 1})
                flow = created.json()
                edits = [
                    {"op": "node.add", "as": "start", "type": "manual", "name": "Start"},
                    {"op": "node.add", "as": "code", "type": "code", "name": "Add 18 and 25", "code": "export default () => ({ total: 18 + 25 })", "config": {"outputs": {"total": {"schema": {"type": "number"}, "nullable": False}}}},
                    {"op": "node.add", "as": "agent", "type": "agent", "name": "Return total", "prompt": 'Return only JSON with numeric answer equal to the supplied total: {{total}}.', "config": {"model": "auto", "maxRounds": 6, "resultSchema": {"type": "object", "properties": {"answer": {"type": "number"}}, "required": ["answer"], "additionalProperties": False}}, "inputs": {"total": {"kind": "output", "node": "$code", "port": "total"}}},
                    {"op": "edge.connect", "source": "$start", "target": "$code"},
                    {"op": "edge.connect", "source": "$code", "target": "$agent"},
                ]
                edited = await checked(client, "POST", f"/v1/flows/{flow['flowId']}/authoring/edit", headers=headers, payload={"baseRevision": flow["draftRevisionId"], "requestId": f"seed-{identity}", "edits": edits})
                if not edited.json().get("saved"):
                    raise HTTPException(503, "Could not prepare the demo workflow.")
                flow_id = flow["flowId"]
                DB.execute("UPDATE visitors SET flow_id=? WHERE visitor=?", (flow_id, identity))
                DB.commit()
            return {"userId": user_id, "flowId": flow_id, "token": token}


@app.post("/preview/session")
async def bootstrap(request: Request):
    value = await session(visitor(request))
    return {"userId": value["userId"], "flowId": value["flowId"]}


@app.get("/health")
async def health():
    return {"status": "ready", "mode": "private-preview"}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy(path: str, request: Request):
    identity = visitor(request)
    if not re.match(r"^v1/(flows|runs|connector|variables|trigger-keys|event-sources)(/|$)", path) or ".." in path or "\\" in path:
        return Response(json.dumps({"error": {"message": "This operation is not available in the private preview."}}), status_code=403, media_type="application/json")
    if request.method != "GET" and ("/publications" in path or path.endswith("/enabled") or path.startswith("v1/event-sources")):
        return Response(json.dumps({"error": {"message": "Publishing and external trigger activation are disabled in this workbench preview. Draft editing and test runs are enabled."}}), status_code=403, media_type="application/json")
    value = await session(identity)
    body = await request.body()
    if len(body) > 2 * 1024 * 1024:
        raise HTTPException(413, "Preview request is too large.")
    headers = {name: request.headers[name] for name in ["content-type", "idempotency-key", "accept", "if-none-match"] if name in request.headers}
    headers["authorization"] = f"Bearer {value['token']}"
    client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10))
    try:
        upstream = await client.send(client.build_request(request.method, f"{UPSTREAM}/{path}", params=request.query_params, content=body, headers=headers), stream=True)
    except Exception:
        await client.aclose()
        raise HTTPException(503, "Workbench backend is temporarily unavailable.") from None

    async def chunks():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    response_headers = {name: upstream.headers[name] for name in ["content-type", "content-disposition", "etag"] if name in upstream.headers}
    response_headers["cache-control"] = "no-store"
    return StreamingResponse(chunks(), status_code=upstream.status_code, headers=response_headers)
