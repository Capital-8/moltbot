import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Exercise the stdlib driver with fake tools/frames, never models, Swift, or network.
const program = String.raw`
import base64, hashlib, importlib.util, io, json, os, signal, struct, sys, tempfile, time, unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
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

    def test_quiet_capture_hard_caps_both_pipes_before_any_echo(self):
        source = "import os; os.write(1,b'private-output'*10000); os.write(2,b'private-stderr'*10000)"
        child = m.Child([sys.executable, "-I", "-S", "-c", source], self.root, dict(os.environ), quiet_limit=1024)
        self.proof.children.append(child)
        with patch.object(sys, "stdout", io.StringIO()) as stdout, patch.object(sys, "stderr", io.StringIO()) as stderr:
            self.assertEqual(child.join(time.monotonic()+5), 0)
            self.assertEqual(stdout.getvalue()+stderr.getvalue(), "")
        self.assertTrue(child.capture_overflow)
        self.assertEqual(len(child.stdout)+len(child.stderr), 1024)
        self.assertTrue(child.joined())

    def test_quiet_deadline_retires_owned_group_and_pipes(self):
        source = "import time; time.sleep(30)"
        # Simulate the join deadline, signaling only this fixture group before retirement.
        real_child = m.Child
        def child(*args, **kwargs):
            instance = real_child(*args, **kwargs)
            def deadline(_):
                os.killpg(instance.group, signal.SIGTERM)
                raise RuntimeError("fixture deadline")
            instance.join = deadline
            return instance
        with patch.object(m, "Child", side_effect=child):
            result = self.proof.quiet_capture([sys.executable, "-I", "-S", "-c", source], 1)
        self.assertTrue(result["child"].joined())
        self.assertEqual(result["failure"], "capture-deadline")

    def test_denials_require_exact_owned_pid_time_and_normalize_paths(self):
        def event(pid, stamp, operation, argument):
            return json.dumps({"timestamp": datetime.fromtimestamp(stamp, timezone.utc).isoformat(), "eventMessage": "Sandbox: probe("+str(pid)+") deny(1) "+operation+" "+argument}).encode()+b"\n"
        raw = event(99, 1001, "file-write-create", str(self.root / "private"))
        raw += event(98, 1001, "mach-lookup", "com.apple.foreign")
        raw += event(99, 999, "mach-lookup", "com.apple.old")
        raw += event(99, 1002, "mach-lookup", "com.apple.trustd")
        raw += b'{"finished":1}\n'
        records = m.sandbox_denials(raw, 99, 1000, 1003, {"owned": self.root})
        self.assertEqual(records, [{"pid":99,"operation":"file-write-create","pathRelation":"owned","resourceState":"available"}, {"pid":99,"operation":"mach-lookup","systemService":"com.apple.trustd","resourceState":"available"}])
        self.assertNotIn(str(self.root), json.dumps(records))
        with self.assertRaisesRegex(RuntimeError, "overflow"):
            m.sandbox_denials(event(99,1001,"mach-lookup","com.apple.trustd")*17+b'{"finished":1}\n',99,1000,1003,{})
        with self.assertRaisesRegex(RuntimeError,"after denial completion"):
            m.sandbox_denials(raw+event(99,1002,"mach-lookup","com.apple.trustd"),99,1000,1003,{})
        with self.assertRaisesRegex(RuntimeError,"lacks completion"):
            m.sandbox_denials(event(99,1001,"mach-lookup","com.apple.trustd"),99,1000,1003,{})

    def test_denial_categories_keep_staging_cache_and_keychain_distinct_without_paths(self):
        arguments=[str(self.root/"tmp/private-file"),str(self.root/"hub/private-file"),"/private/var/folders/ab/opaque-runner/T/private-file","/var/folders/ab/opaque-runner/C/private-file","/Library/Keychains/System.keychain","<private>","/unclassified/private-file"]
        raw=b"".join(json.dumps({"timestamp":"1970-01-01 00:16:41.000000+0000","eventMessage":"Sandbox: probe(99) deny(1) file-write-create "+arg}).encode()+b"\n" for arg in arguments)+b'{"finished":1}\n'
        roots={"probe-tmp":self.root/"tmp","probe-hf-cache":self.root/"hub","owned":self.root}
        records=m.sandbox_denials(raw,99,1000,1003,roots)
        self.assertEqual([r.get("pathRelation") for r in records],["probe-tmp","probe-hf-cache","darwin-user-temp","darwin-user-cache","system-keychain",None,"outside-known-roots"])
        self.assertTrue(all(r["resourceState"]=="available" for r in records[:5]))
        self.assertTrue(all(r["resourceState"]=="unavailable" for r in records[5:]))
        serialized=json.dumps(records)
        for private in ["opaque-runner","private-file","System.keychain",str(self.root)]:
            self.assertNotIn(private,serialized)

    def test_log_overflow_and_capture_failure_are_unavailable_not_partial_success(self):
        target = SimpleNamespace(process=SimpleNamespace(pid=99), joined=lambda: True)
        captured = SimpleNamespace(capture_overflow=True, stdout=b"private-system-output")
        calls = []
        self.proof.quiet_capture = lambda argv, seconds: calls.append((argv,seconds)) or {"code":0,"failure":None,"child":captured}
        result = self.proof.denial_receipt({"child":target,"started":1000,"ended":1003})
        self.assertEqual(result, {"state":"unavailable","records":[]})
        self.assertNotIn("private", json.dumps(result))
        argv, seconds = calls[0]
        self.assertEqual(seconds,10)
        self.assertIn("@1000.000000",argv)
        self.assertIn("@1003.000000",argv)
        self.assertIn('(eventMessage CONTAINS "(99)")',argv[-1])
        captured.capture_overflow=False
        captured.stdout=b""
        self.assertEqual(self.proof.denial_receipt({"child":target,"started":1000,"ended":1003})["state"],"unavailable")
        captured.stdout=b'{"timestamp":"1970-01-01 00:16:41+0000","eventMessage":"Sandbox: probe(99) deny(1) file-write-create <private>"}\n{"finished":1}\n'
        redacted=self.proof.denial_receipt({"child":target,"started":1000,"ended":1003})
        self.assertEqual(redacted["state"],"unavailable")
        self.assertEqual(redacted["records"][0]["operation"],"file-write-create")

    def test_collector_retirement_failure_preserves_native_error_stops_secondary_and_retains_scratch(self):
        profile=self.root/"scripts/macos-health-render.sb"
        profile.parent.mkdir()
        profile.write_text("(version 1)\n(allow default)\n(deny network*)\n")
        calls=[]
        class FakeChild:
            failing=True
            def __init__(self,argv,*args,**kwargs):
                args=[str(x) for x in argv]
                self.log=args[0]=="/usr/bin/log"
                mode="download" if "download" in args else "data" if "data" in args else None
                calls.append("log" if self.log else mode or "compiler")
                self.process=SimpleNamespace(pid=99 if mode else 100)
                self.capture_overflow=False
                self.stdout=bytearray(json.dumps({"pid":99,"mode":mode,"ok":False,"failure":"native-task","errors":[{"domain":"NSPOSIXErrorDomain","code":1}]}).encode()) if mode else bytearray()
                self.stderr=bytearray()
                self.code=1 if mode else 0
            def join(self,deadline): return self.code
            def joined(self): return not (self.log and self.failing)
            def retire(self,deadline):
                if self.log and self.failing: raise RuntimeError("fixture collector pipes unretired")
        with patch.object(m,"Child",FakeChild):
            with self.assertRaises(m.CaptureCustodyError):
                self.proof.foundation_admission()
        self.assertEqual(calls,["compiler","download","log"])
        primary=self.proof.result["foundationAdmission"]["primary"]
        self.assertEqual(primary["errors"],[{"domain":"NSPOSIXErrorDomain","code":1}])
        self.assertEqual(primary["sandboxDenials"]["state"],"custody-unverified")
        with self.assertRaisesRegex(RuntimeError,"cleanup is incomplete"):
            self.proof.close()
        self.assertTrue(self.scratch.exists())
        self.assertFalse(self.proof.result["scratchRemoved"])
        self.assertFalse(self.proof.result["processesAndPipesRetired"])
        FakeChild.failing=False

    def test_probe_receipt_rejects_foreign_pid_raw_fields_and_false_success(self):
        receipt = {"pid":99,"mode":"download","ok":True,"moved":True,"status":200,"acceptedBytes":680,"gitBlob":m.FILES["config.json"][1],"url":m.CONFIG_URL}
        self.assertEqual(m.foundation_record(json.dumps(receipt).encode(),99,"download"),receipt)
        for update in [{"pid":98},{"headers":"private"},{"acceptedBytes":681},{"moved":False},{"url":m.CONFIG_URL+"?private=true"}]:
            with self.assertRaises(RuntimeError):
                m.foundation_record(json.dumps({**receipt,**update}).encode(),99,"download")

    def test_native_download_precedes_control_and_secondary_cannot_override_failure(self):
        self.proof.quiet_capture = lambda *args, **kwargs: {"code":0,"failure":None,"child":SimpleNamespace(capture_overflow=False)}
        calls=[]
        def attempt(binary,mode):
            calls.append(mode)
            return {"ok": mode == "data"}
        self.proof.foundation_attempt=attempt
        with self.assertRaisesRegex(RuntimeError,"native download admission failed"):
            self.proof.foundation_admission()
        self.assertEqual(calls,["download","data"])
        self.assertFalse(self.proof.result["foundationAdmission"]["primary"]["ok"])
        self.assertTrue(self.proof.result["foundationAdmission"]["secondary"]["ok"])
        calls.clear()
        self.proof.foundation_attempt=lambda binary,mode: calls.append(mode) or {"ok":True}
        self.proof.foundation_admission()
        self.assertEqual(calls,["download"])

    def test_callback_contract_and_stream_caps_preserve_hf_default_shape(self):
        source=m.FOUNDATION_SOURCE
        self.assertIn("URLSession(configuration: .default)",source)
        self.assertIn("URLSession(configuration: original.configuration, delegate: self",source)
        self.assertIn("session.downloadTask(with: url)",source)
        self.assertIn("didFinishDownloadingTo location: URL",source)
        self.assertLess(source.index('relation(temporary) == "owned"'),source.index("moveItem(at: location"))
        self.assertLess(source.index("data.count <= 680 - bytes.count"),source.index("bytes.append(data)"))
        self.assertIn("totalBytesWritten <= 680",source)
        self.assertIn("callback-move-or-read",source)
        for forbidden in ["ephemeral", "requestCachePolicy", "httpCookieStorage", "urlCredentialStorage", "localizedDescription", "allHeaderFields"]:
            self.assertNotIn(forbidden,source)

    def test_callback_failure_receipt_is_preserved_and_quiet(self):
        value={"pid":99,"mode":"download","ok":False,"failure":"callback-move-or-read","callbackRelation":"outside-owned","errors":[{"domain":"NSCocoaErrorDomain","code":513}]}
        child=SimpleNamespace(process=SimpleNamespace(pid=99),capture_overflow=False,stdout=json.dumps(value).encode(),stderr=bytearray(b"private unsolicited Foundation stderr"))
        self.proof.quiet_capture=lambda *args,**kwargs: {"child":child,"code":1,"failure":None,"started":1,"ended":2}
        self.proof.denial_receipt=lambda capture: {"state":"unavailable","records":[]}
        profile=self.root/"scripts/macos-health-render.sb"
        profile.parent.mkdir()
        profile.write_text("(version 1)\n(allow default)\n(deny network*)\n")
        record=self.proof.foundation_attempt(Path("fixture"),"download")
        self.assertFalse(record["ok"])
        self.assertEqual(record["failure"],"callback-move-or-read")
        self.assertTrue(record["stderrPresent"])
        self.assertNotIn("private",json.dumps(record))
        child.capture_overflow=True
        child.stdout=b"private-overflow-not-json"
        overflow=self.proof.foundation_attempt(Path("fixture"),"download")
        self.assertEqual(overflow["failure"],"receipt-unavailable")
        self.assertNotIn("private",json.dumps(overflow))

    def test_foundation_only_requires_admission_and_returns_before_build_or_models(self):
        with self.assertRaisesRegex(RuntimeError,"requires extended"):
            self.proof.execute(False,True)
        self.proof.verify_source=lambda *args: {"sha":"a"*40}
        self.proof.foundation_admission=lambda: None
        self.proof.build=lambda *args: self.fail("unexpected helper build")
        self.proof.extended=lambda *args: self.fail("unexpected model proof")
        with patch.dict(os.environ,{"CHECKOUT_SHA":"a"*40,"GITHUB_RUN_ID":"1","GITHUB_RUN_ATTEMPT":"1","GITHUB_JOB":"fixture"}):
            self.proof.execute(True,True)
        self.assertTrue(self.proof.result["diagnosticOnly"])
        self.assertTrue(self.proof.result["diagnosticComplete"])
        for field in ["helperBuildRun","modelInferenceRun","offlineHelperCacheComplete","settingsUpgradeComplete","complete"]:
            self.assertFalse(self.proof.result[field])
        result=m.subprocess.run([sys.executable,"-I","-S",sys.argv[1],"--proof-dir",str(self.artifacts),"--started",str(time.monotonic()),"--foundation-admission-only"],capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn(b"requires extended",result.stderr)

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
