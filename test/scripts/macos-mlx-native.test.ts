import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Exercise the stdlib driver with fake tools/frames, never models, Swift, or network.
const program = String.raw`
import base64, hashlib, importlib.util, json, os, signal, struct, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("mlx_proof", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openclaw-mlx-proof-test-")
        self.root = Path(self.temp.name)
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        self.artifacts = self.root / "proof"
        self.artifacts.mkdir()
        self.proof = m.Proof(self.root, self.scratch, self.artifacts, m.Budget(time.monotonic()))

    def tearDown(self):
        self.proof.close()
        self.temp.cleanup()

    def test_fragmented_frames_and_length_guards(self):
        packet = m.frame({"type": "ready"}) + m.frame({"type": "completed", "id": "a"})
        buffer = bytearray()
        events = []
        for byte in packet:
            buffer.append(byte)
            events += m.decode_frames(buffer)
        self.assertEqual(events, [{"type": "ready"}, {"type": "completed", "id": "a"}])
        self.assertEqual(buffer, b"")
        for length in [0, m.FRAME_LIMIT + 1]:
            with self.assertRaisesRegex(RuntimeError, "frame length"):
                m.decode_frames(bytearray(struct.pack(">I", length)))

    def test_real_child_pipes_and_group_are_joined(self):
        source = "import sys; sys.stdout.buffer.write(bytes.fromhex('00000010')+b'{\"type\":\"ready\"}'); sys.stdout.flush()"
        child = m.Child([sys.executable, "-I", "-S", "-c", source], self.root, dict(os.environ), framed=True)
        self.proof.children.append(child)
        self.assertEqual(child.event(time.monotonic()+5), {"type": "ready"})
        self.assertEqual(child.join(time.monotonic()+5), 0)
        self.assertTrue(child.joined())

    def test_decoder_failure_does_not_block_child_retirement(self):
        child = m.Child([sys.executable, "-I", "-S", "-c", "import time; time.sleep(30)"], self.root, dict(os.environ), framed=True)
        self.proof.children.append(child)
        child.on_tick = lambda: (_ for _ in ()).throw(RuntimeError("cache failure"))
        os.killpg(child.group, signal.SIGTERM)
        child.retire(time.monotonic()+5)
        self.assertTrue(child.joined())

    def test_budget_is_not_refreshed_per_phase(self):
        budget = m.Budget(time.monotonic() - 26 * 60)
        self.assertLess(budget.deadline(480) - time.monotonic(), 61)
        with self.assertRaisesRegex(RuntimeError, "budget"):
            m.Budget(time.monotonic() - 28 * 60)

    def test_selected_checkout_is_not_the_workflow_or_trigger_commit(self):
        selected, workflow, trigger = "a" * 40, "b" * 40, "c" * 40
        self.proof.verify_source = lambda source, revision: {"sha": revision} if revision == selected else self.fail("wrong source")
        self.proof.build = lambda name, source: None
        with patch.dict(os.environ, {"CHECKOUT_SHA": selected, "GITHUB_WORKFLOW_SHA": workflow, "GITHUB_SHA": trigger, "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "fixture"}):
            self.proof.execute(False)
        self.assertEqual(self.proof.result["source"]["sha"], selected)
        self.assertEqual(self.proof.result["workflowSHA"], workflow)
        self.assertEqual(self.proof.result["triggerSHA"], trigger)
        self.assertIn("source_sha=" + selected, (self.artifacts / "source.txt").read_text())

    def test_historical_fetch_bounds_ancestry_and_keeps_committed_inputs(self):
        data = b"committed fixture"
        blob = hashlib.sha1(b"blob 17\0" + data).hexdigest()
        entries = "\n".join("100644 blob " + blob + "\t" + p for p in m.INPUTS)
        self.proof.git = lambda *args: entries if args[0] == "ls-tree" else "fixture-tree"
        calls = []
        self.proof.command = lambda argv, *args, **kwargs: calls.append(argv) or ""
        def git_result(argv, **kwargs):
            return m.subprocess.CompletedProcess(argv, 1 if "-e" in argv else 0, stdout=data)
        with patch.object(m.subprocess, "run", side_effect=git_result):
            snapshot = self.proof.snapshot("stable", m.STABLE)
        fetch = calls[0]
        self.assertIn("--depth=1", fetch)
        for flag in ["--no-auto-maintenance", "--no-write-commit-graph", "--no-write-fetch-head", "--no-tags", "--no-prune", "--no-recurse-submodules", "--refmap="]:
            self.assertIn(flag, fetch)
        self.assertEqual(fetch[-2:], ["https://github.com/openclaw/openclaw.git", m.STABLE])
        self.assertTrue(all((snapshot / p).read_bytes() == data for p in m.INPUTS))

    def test_online_profile_removes_only_network_denial(self):
        profile = self.root / "scripts/macos-health-render.sb"
        profile.parent.mkdir()
        original = (Path(sys.argv[1]).parent / "macos-health-render.sb").read_bytes()
        profile.write_bytes(original)
        argv = self.proof.sandbox(["fixture-helper"], online=True)
        generated = Path(argv[argv.index("-f") + 1])
        self.assertEqual(generated.read_bytes(), original.replace(b"(deny network*)\n", b"", 1))
        self.assertEqual(profile.read_bytes(), original)
        self.assertFalse(self.proof.result["coldIsolation"]["sharedOSStoreIsolationProven"])
        self.assertEqual(self.proof.sandbox(["fixture-helper"])[-2], profile)
        profile.write_bytes(original.replace(b"(deny network*)\n", b""))
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.proof.sandbox(["fixture-helper"], online=True)

    def fake_build(self, stale=False, mutate=False):
        package = self.root / m.PACKAGE
        package.mkdir(parents=True)
        (package / "Package.swift").write_text("fixture manifest")
        (package / "Package.resolved").write_text('{"pins": []}')
        self.proof.result["variants"]["fixed"] = {}
        calls = []
        def command(argv, seconds, cwd=None, env=None):
            args = [str(x) for x in argv]
            calls.append(args)
            if args[:2] == ["swift", "package"] and stale:
                (package / "Package.resolved").write_text('{"pins": [], "changed": true}')
            if "--show-bin-path" in args:
                binary = self.scratch / "fixed-build/bin"
                library = binary / "mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib"
                library.parent.mkdir(parents=True)
                library.write_text("fixture Metal library")
                (binary / "openclaw-mlx-tts").write_text("fixture executable")
                return str(binary)
            if args[:2] == ["swift", "test"] and mutate:
                (package / "Package.resolved").write_text('{"pins": [], "mutated": true}')
            return "fixture output"
        self.proof.command = command
        return calls

    def test_stale_lock_keeps_resolver_receipt_but_remains_failure(self):
        calls = self.fake_build(stale=True)
        with self.assertRaisesRegex(RuntimeError, "inputs changed"):
            self.proof.build("fixed", self.root)
        self.assertTrue(any(c[:2] == ["swift", "test"] for c in calls))
        self.assertFalse(self.proof.result["variants"]["fixed"]["committedResolutionMatches"])
        self.assertIn("changed", (self.artifacts / "Package.resolved").read_text())

    def test_post_build_lock_mutation_is_not_success(self):
        self.fake_build(mutate=True)
        with self.assertRaisesRegex(RuntimeError, "inputs changed"):
            self.proof.build("fixed", self.root)

    def test_pcm_contract_rejects_wrong_ids_format_and_silence(self):
        class Helper:
            def send(self, value, deadline): pass
        audio = {"id": "a", "format": "pcm_s16le", "sampleRate": 32000, "channels": 1, "pcm": base64.b64encode(b"\x01\x00").decode()}
        for update in [{"id": "other"}, {"sampleRate": 16000}, {"pcm": "AAA="}]:
            self.proof.receive = lambda *args: {"type": "audio", "audio": {**audio, **update}}
            with self.assertRaises(RuntimeError):
                self.proof.pcm(Helper(), "a")
        self.proof.receive = lambda *args: {"type": "audio", "audio": audio}
        self.proof.pcm(Helper(), "a")
        self.assertEqual(self.proof.result["requests"][-1]["pcmBytes"], 2)

    def test_busy_id_and_cancel_terminal_are_both_required(self):
        class Helper:
            def send(self, value, deadline): pass
        self.proof.receive = lambda *args: {"type": "error", "error": {"id": "wrong", "code": "busy"}}
        with self.assertRaisesRegex(RuntimeError, "busy"):
            self.proof.active_cancel(Helper(), "a")
        events = iter([{"type":"error","error":{"id":"a-busy","code":"busy"}}, {"type":"audio","audio":{"id":"a"}}])
        self.proof.receive = lambda *args: next(events)
        with self.assertRaisesRegex(RuntimeError, "canceled"):
            self.proof.active_cancel(Helper(), "a")

    def test_only_network_model_load_failure_counts_as_bad_cache_red(self):
        event = {"type": "error", "error": {"id": "bad-offline", "code": "model_load_failed", "message": "NSURLErrorDomain Code=-1009"}}
        self.assertEqual(m.denied_cache_error(event), event["error"])
        for field, value in [("message", "file permission denied"), ("id", "wrong"), ("code", "generation_failed")]:
            with self.assertRaises(RuntimeError):
                m.denied_cache_error({"type": "error", "error": {**event["error"], field: value}})

    def test_model_bytes_and_cache_containment_are_verified(self):
        original = m.FILES
        try:
            data = b"fixture"
            m.FILES = {"config.json": (len(data), hashlib.sha1(b"blob 7\0"+data).hexdigest())}
            root = self.proof.cache_root / "model"
            root.mkdir()
            (root / "config.json").write_bytes(data)
            self.proof.model_files(root)
            (root / "config.json").write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "identity"):
                self.proof.model_files(root)
            (root / "config.json").unlink()
            (root / "config.json").symlink_to(self.root / "outside")
            with self.assertRaisesRegex(RuntimeError, "escapes"):
                self.proof.model_files(root)
        finally:
            m.FILES = original

unittest.main(argv=["mlx-native-mocks"], verbosity=2)
`;

it("enforces native proof framing, identity, deadlines and owned cleanup without models", () => {
  const output = execFileSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      program,
      fileURLToPath(new URL("../../scripts/test-macos-mlx-native.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(output).toContain("[mlx-native] fixed: resolve and build");
});
