"""Contract tests use a fake scorer, never import or download model dependencies."""
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class FakeScorer:
    def compute_score(self, pairs, **kwargs):
        return [0.9 if "relevant" in document else 0.1 for _, document in pairs]


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server._model = FakeScorer()
        server.API_KEY = "test-key"
        cls.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()
        cls.url = f"http://127.0.0.1:{cls.http.server_port}/rerank"

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join()

    def post(self, body, key="test-key"):
        request = Request(self.url, data=json.dumps(body).encode(), headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json"
        })
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_rank_preserves_original_indexes(self):
        status, body = self.post({"query": "q", "documents": ["noise", "relevant"], "top_n": 2})
        self.assertEqual(status, 200)
        self.assertEqual([row["index"] for row in body["results"]], [1, 0])

    def test_auth_and_model_boundaries(self):
        self.assertEqual(self.post({"query": "q", "documents": ["x"]}, "wrong")[0], 401)
        self.assertEqual(self.post({"query": "q", "documents": ["x"], "model": "other"})[0], 400)

    def test_invalid_and_oversized_candidates(self):
        self.assertEqual(self.post({"query": "q", "documents": ["x"] * 101})[0], 400)
        self.assertEqual(self.post({"query": "q", "documents": ["x"], "top_n": True})[0], 400)

    def test_overload_rejects_without_queuing(self):
        with server._inference_lock:
            self.assertEqual(self.post({"query": "q", "documents": ["x"]})[0], 503)


if __name__ == "__main__":
    unittest.main()
