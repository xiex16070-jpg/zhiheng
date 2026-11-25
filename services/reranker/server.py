"""Optional local BGE cross-encoder service. Python 3.10+; no Node process dependency."""
import hmac
import json
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
MODEL_PATH = os.environ.get("RERANK_MODEL_PATH", MODEL)
API_KEY = os.environ.get("RERANK_API_KEY", "")
DEVICE = os.environ.get("RERANK_DEVICE", "cpu")
FP16 = os.environ.get("RERANK_FP16", "0").lower() in ("1", "true") and DEVICE != "cpu"
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_DOCUMENTS = 100
MAX_CHARS = 12000
_inference_lock = threading.Lock()
_model = None


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not_found"})
        self.reply(200, {"ready": _model is not None, "model": MODEL, "device": DEVICE})

    def do_POST(self):
        if self.path != "/rerank":
            return self.reply(404, {"error": "not_found"})
        if API_KEY and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + API_KEY):
            return self.reply(401, {"error": "unauthorized"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error": "invalid_content_length"})
        if not 0 < size <= MAX_BODY_BYTES:
            return self.reply(413, {"error": "request_too_large_or_empty"})
        try:
            body = json.loads(self.rfile.read(size))
            query = body["query"]
            documents = body["documents"]
            top_n = body.get("top_n", len(documents))
            if not isinstance(query, str) or not 1 <= len(query) <= 4000:
                raise ValueError("invalid query")
            if not isinstance(documents, list) or not 1 <= len(documents) <= MAX_DOCUMENTS:
                raise ValueError("invalid documents")
            if any(not isinstance(doc, str) or len(doc) > MAX_CHARS for doc in documents):
                raise ValueError("invalid document")
            if type(top_n) is not int or not 1 <= top_n <= len(documents):
                raise ValueError("invalid top_n")
            if body.get("model", MODEL) != MODEL:
                return self.reply(400, {"error": "model_mismatch", "model": MODEL})
        except (ValueError, KeyError, TypeError, AttributeError):
            return self.reply(400, {"error": "invalid_request"})
        # Reject overload immediately: abandoned HTTP requests must not create
        # an unbounded queue of model computations behind the Node timeout.
        if not _inference_lock.acquire(blocking=False):
            return self.reply(503, {"error": "busy"})
        try:
            scores = _model.compute_score(
                [[query, document] for document in documents],
                normalize=True,
                batch_size=int(os.environ.get("RERANK_BATCH_SIZE", "8")),
                max_length=int(os.environ.get("RERANK_MAX_TOKENS", "512")),
            )
            if not isinstance(scores, (list, tuple)) and not hasattr(scores, "__len__"):
                scores = [scores]
            scores = [float(score) for score in scores]
            if len(scores) != len(documents) or not all(math.isfinite(score) for score in scores):
                raise ValueError("invalid model output")
            results = sorted(
                [{"index": index, "relevance_score": score} for index, score in enumerate(scores)],
                key=lambda row: (-row["relevance_score"], row["index"]),
            )
            self.reply(200, {"model": MODEL, "results": results[:top_n]})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.reply(500, {"error": "inference_failed"})
        finally:
            _inference_lock.release()


def main():
    global _model
    from FlagEmbedding import FlagReranker

    # Download/cache happens only when this optional service is explicitly run.
    _model = FlagReranker(MODEL_PATH, use_fp16=FP16, devices=[DEVICE], trust_remote_code=False)
    host = os.environ.get("RERANK_HOST", "127.0.0.1")
    port = int(os.environ.get("RERANK_PORT", "8091"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"BGE reranker ready at http://{host}:{port}; model={MODEL}; device={DEVICE}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
