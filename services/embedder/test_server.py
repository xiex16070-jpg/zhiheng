"""HTTP contract only: uses a deterministic vector fixture, not real BGE quality."""
import unittest
import tempfile
import json
import hashlib
from pathlib import Path
from fastapi.testclient import TestClient
import server


class FixtureModel:
    def encode(self, texts, **kwargs):
        return {"dense_vecs": [[1.0] + [0.0] * 1023 for _ in texts]}


class ContractTests(unittest.TestCase):
    def setUp(self):
        server.model = FixtureModel()
        server.KEY = "fixture-secret"
        self.client = TestClient(server.app)  # No context manager: no weight-loading lifespan.
        self.headers = {"authorization": "Bearer fixture-secret"}

    def tearDown(self):
        self.client.close()

    def test_embedding_identity_and_auth(self):
        request = {"model": server.MODEL, "input": ["合取", "conjunction"]}
        self.assertEqual(self.client.post("/embed", json=request).status_code, 401)
        result = self.client.post("/embed", json=request, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(result.json()["data"]), 2)
        self.assertEqual(len(result.json()["data"][0]["embedding"]), 1024)
        request["model"] = "other-model"
        self.assertEqual(self.client.post("/embed", json=request, headers=self.headers).status_code, 400)

    def test_bounds_busy_and_health(self):
        self.assertTrue(self.client.get("/health").json()["ready"])
        self.assertEqual(self.client.post("/embed", json={"model": server.MODEL, "input": ["x"] * 33}, headers=self.headers).status_code, 400)
        self.assertEqual(self.client.post("/embed", content=b"x" * (server.MAX_BYTES + 1), headers=self.headers).status_code, 413)
        server.lock.acquire()
        try:
            self.assertEqual(self.client.post("/embed", json={"model": server.MODEL, "input": ["x"]}, headers=self.headers).status_code, 503)
        finally:
            server.lock.release()

    def test_pinned_weight_manifest_rejects_tampering_and_path_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            weight = root / "pytorch_model.bin"
            weight.write_bytes(b"contract fixture, not model weights")
            checksum = hashlib.sha256(weight.read_bytes()).hexdigest()
            row = {"path": "pytorch_model.bin", "bytes": weight.stat().st_size, "sha256": checksum, "officialLfsSha256": checksum}
            manifest = {"model": server.MODEL, "revision": "pinned", "verified": True, "files": [row]}
            file = root / "manifest.json"
            file.write_text(json.dumps(manifest))
            self.assertTrue(server.verify_weights(root, file, "pinned")["verifiedWeights"])
            with self.assertRaises(ValueError):
                server.verify_weights(root, file, "different")
            weight.write_bytes(b"X" * row["bytes"])
            with self.assertRaises(ValueError):
                server.verify_weights(root, file, "pinned")
            manifest["files"][0]["path"] = "../outside.bin"
            file.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                server.verify_weights(root, file, "pinned")


if __name__ == "__main__":
    unittest.main()
