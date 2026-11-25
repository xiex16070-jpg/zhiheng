"""Opt-in BGE-M3 dense embedding service; no input or credentials in logs."""
import asyncio
import hmac
import hashlib
import json
import math
import os
import threading
import time
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

MODEL = os.getenv("EMBEDDER_MODEL", "BAAI/bge-m3")
REVISION = os.getenv("EMBEDDER_REVISION", "")
KEY = os.getenv("EMBEDDER_API_KEY", "")
DEVICE = os.getenv("EMBEDDER_DEVICE", "cpu")
MAX_BYTES = 2 * 1024 * 1024
lock = threading.Lock()
model = None
weight_status = {"verifiedWeights": False, "weightsSha256": None, "manifestSha256": None}
metrics = {"requestsCompleted": 0, "vectorsEncoded": 0, "lastBatchMs": None}


def verify_weights(directory, manifest_path, revision):
    """Verify an operator-pinned snapshot before trusting a local model directory."""
    root = Path(directory).resolve()
    raw = Path(manifest_path).read_bytes()
    manifest = json.loads(raw)
    if manifest.get("model") != MODEL or manifest.get("revision") != revision or manifest.get("verified") is not True:
        raise ValueError("Pinned weight manifest identity mismatch")
    weights = None
    for row in manifest.get("files", []):
        target = (root / row["path"]).resolve()
        if not target.is_relative_to(root) or not target.is_file() or target.stat().st_size != row["bytes"]:
            raise ValueError("Pinned weight file boundary or size mismatch")
        with target.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if not hmac.compare_digest(actual, str(row["sha256"])) or (row.get("officialLfsSha256") and actual != row["officialLfsSha256"]):
            raise ValueError("Pinned weight checksum mismatch")
        if row["path"] == "pytorch_model.bin":
            weights = actual
    if not weights:
        raise ValueError("Pinned model weights absent")
    return {"verifiedWeights": True, "weightsSha256": weights, "manifestSha256": hashlib.sha256(raw).hexdigest()}


@asynccontextmanager
async def lifespan(app):
    global model, weight_status
    import torch
    from FlagEmbedding import BGEM3FlagModel
    torch.set_num_threads(max(1, min(32, int(os.getenv("EMBEDDER_CPU_THREADS", "8")))))
    model_path = os.getenv("EMBEDDER_MODEL_PATH", MODEL)
    manifest = os.getenv("EMBEDDER_WEIGHT_MANIFEST", "")
    if manifest:
        weight_status = verify_weights(model_path, manifest, REVISION)
    model = BGEM3FlagModel(model_path, devices=[DEVICE],
                          use_fp16=DEVICE != "cpu" and os.getenv("EMBEDDER_FP16", "0") == "1",
                          trust_remote_code=False)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/health")
async def health():
    return {"ready": model is not None, "model": MODEL, "revision": REVISION, "dim": 1024,
            "device": DEVICE, "cpuThreads": int(os.getenv("EMBEDDER_CPU_THREADS", "8")),
            "maxTokens": int(os.getenv("EMBEDDER_MAX_TOKENS", "1024")),
            **weight_status, **metrics}


def calculate(texts):
    started = time.perf_counter()
    try:
        vectors = model.encode(texts, batch_size=int(os.getenv("EMBEDDER_BATCH", "4")),
                               max_length=int(os.getenv("EMBEDDER_MAX_TOKENS", "1024")),
                               return_dense=True, return_sparse=False, return_colbert_vecs=False)["dense_vecs"]
        rows = [[float(x) for x in row] for row in vectors]
        if len(rows) != len(texts) or any(len(row) != 1024 or not all(math.isfinite(x) for x in row) for row in rows):
            raise ValueError("invalid_model_output")
        metrics.update(requestsCompleted=metrics["requestsCompleted"] + 1,
                       vectorsEncoded=metrics["vectorsEncoded"] + len(rows),
                       lastBatchMs=round((time.perf_counter() - started) * 1000, 2))
        return rows
    finally:
        lock.release()


@app.post("/embed")
async def embed(request: Request):
    if KEY and not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + KEY):
        return JSONResponse({"error": "unauthorized"}, 401)
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            return JSONResponse({"error": "too_large"}, 413)
    try:
        body = json.loads(data)
        texts = body["input"]
        if body.get("model") != MODEL or (body.get("revision") and body["revision"] != REVISION):
            return JSONResponse({"error": "model_identity_mismatch"}, 400)
        if not isinstance(texts, list) or not 1 <= len(texts) <= 32 or any(not isinstance(x, str) or not 1 <= len(x) <= 12000 for x in texts):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        return JSONResponse({"error": "invalid_request"}, 400)
    if model is None or not lock.acquire(blocking=False):
        return JSONResponse({"error": "busy_or_unavailable"}, 503)
    try:
        # calculate owns the lock until PyTorch actually finishes, even if HTTP is cancelled.
        vectors = await asyncio.to_thread(calculate, texts)
        return {"model": MODEL, "revision": REVISION, "data": [{"index": i, "embedding": row} for i, row in enumerate(vectors)]}
    except Exception:
        return JSONResponse({"error": "embedding_failed"}, 500)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.getenv("EMBEDDER_HOST", "127.0.0.1"), port=int(os.getenv("EMBEDDER_PORT", "8092")), access_log=False)
