"""Focused regression checks. No provider calls or credentials required."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "model_proxy", Path(__file__).with_name("workbench-model-proxy.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReasoningPolicyTests(unittest.TestCase):
    def test_missing_reasoning_is_disabled(self):
        result = json.loads(module.without_thinking(b'{"model":"auto","input":"hi"}'))
        self.assertEqual(result["reasoning"], {"effort": "none"})
        self.assertEqual(result["input"], "hi")

    def test_existing_reasoning_is_overridden(self):
        result = json.loads(module.without_thinking(
            b'{"reasoning":{"effort":"high","summary":"auto"},"stream":true,"tools":[]}'
        ))
        self.assertEqual(result["reasoning"], {"effort": "none"})
        self.assertTrue(result["stream"])
        self.assertEqual(result["tools"], [])

    def test_invalid_payloads_are_rejected(self):
        for body in [b"bad-json", b"[]", b"null"]:
            with self.assertRaises(ValueError):
                module.without_thinking(body)


if __name__ == "__main__":
    unittest.main()
