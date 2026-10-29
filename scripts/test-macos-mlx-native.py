#!/usr/bin/env python3
"""Disposable org-CI proof for the real MLX helper; never uses an operator profile."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request


STABLE = "8b18b5578f66eab1501cba4cef2310d88bfb9a41"  # v2026.10.9, not a moving release.
BAD = "6d3c68afc27ba52972a76deb2cee0e483d6e1b4f"
MODEL = "mlx-community/Soprano-80M-bf16"
REVISION = "b7da048eff3dfd556409a44b78b9c61a9dd4ccfa"
FILES = {
    "config.json": (680, "cfaff3fd177b291ecc244a181dceaa2168ef373a"),
    "model.safetensors": (217333883, "95e42d42bc879213d49d940e0884024eb153fb6daccf2229864cca0fbbbb268a"),
    "model.safetensors.index.json": (20898, "339bb569f743d59229c4efa7191b57b6e8d9d93d"),
    "special_tokens_map.json": (158, "c17f7dea55ee6007de7886fc804602a15bcefe44"),
    "tokenizer.json": (1792331, "6b6ffca6f6732bd67cfeb7a6de883884d5ecc054"),
    "tokenizer_config.json": (1494887, "aa19994c965569c529847a4c6c92e07f1eae0fe7"),
}
PACKAGE = "apps/macos-mlx-tts"
PROTOCOL = "apps/shared/OpenClawMLXTTSProtocol"
INPUTS = [
    f"{PACKAGE}/Package.swift",
    f"{PACKAGE}/Package.resolved",
    f"{PACKAGE}/Sources/OpenClawMLXTTSHelper/main.swift",
    f"{PACKAGE}/Sources/OpenClawMLXTTSRuntime/MLXTTSHelperService.swift",
    f"{PROTOCOL}/Sources/OpenClawMLXTTSProtocol/MLXTTSProtocol.swift",
]
TEXT = "The quiet fox waits beside the river."
ACTIVE_TEXT = (
    "Along the quiet river, the patient fox watches the evening light settle over the stones and waits for the wind. "
    "The path behind the old bridge stays empty while distant birds circle above the forest and the water moves below."
)
FRAME_LIMIT = 64 * 1024 * 1024  # The shared Swift frame codec's public limit.
PCM_LIMIT = 16 * 1024 * 1024
CACHE_LIMIT = 2 * 1024 * 1024 * 1024  # Includes Hub duplication and both legacy fixtures.
METAL_SOURCE = r'''import Darwin
import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else {
    print("MLX Metal device: unavailable; library not loaded")
    exit(CommandLine.arguments[2] == "required" ? 1 : 0)
}
print("MLX Metal device: \(device.name)")
do {
    _ = try device.makeLibrary(URL: URL(fileURLWithPath: CommandLine.arguments[1]))
    print("MLX Metal library: available")
} catch {
    print("MLX Metal library: unavailable (\(error))")
    exit(1)
}
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def frame(value):
    body = json.dumps(value, separators=(",", ":")).encode()
    require(0 < len(body) <= FRAME_LIMIT, "invalid request frame length")
    return struct.pack(">I", len(body)) + body


def decode_frames(buffer):
    result = []
    while len(buffer) >= 4:
        length = struct.unpack(">I", buffer[:4])[0]
        require(0 < length <= FRAME_LIMIT, "invalid helper frame length")
        if len(buffer) < 4 + length:
            break
        value = json.loads(buffer[4:4 + length])
        require(isinstance(value, dict), "helper frame is not an object")
        result.append(value)
        del buffer[:4 + length]
    return result


def denied_cache_error(event):
    error = event.get("error", {})
    require(event.get("type") == "error" and error.get("id") == "bad-offline" and error.get("code") == "model_load_failed", "bad variant did not fail at model load")
    # A file permission or GPU failure is not the expected network/cache red.
    require(re.search(r"NSURLError|networkError|network connection|internet connection|Network is unreachable|Could not resolve host|DNS", error.get("message", ""), re.I), "bad load error does not identify denied-network path")
    return error


class Budget:
    def __init__(self, started):
        require(0 <= time.monotonic() - started < 27 * 60, "unknown or exhausted native job budget")
        self.work_end = started + 27 * 60
        self.cleanup_end = started + 30 * 60

    def deadline(self, seconds):
        require(time.monotonic() < self.work_end, "native proof work budget exhausted")
        return min(self.work_end, time.monotonic() + seconds)


class Child:
    """Own one process group and all three pipes, including on deadline failure."""

    def __init__(self, argv, cwd, env, framed=False):
        self.process = subprocess.Popen(
            [str(x) for x in argv], cwd=cwd, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True, start_new_session=True,
        )
        self.group = self.process.pid
        self.selector = selectors.DefaultSelector()
        for pipe, name in [(self.process.stdout, "stdout"), (self.process.stderr, "stderr")]:
            os.set_blocking(pipe.fileno(), False)
            self.selector.register(pipe, selectors.EVENT_READ, name)
        os.set_blocking(self.process.stdin.fileno(), False)
        self.framed = framed
        self.buffer = bytearray()
        self.events = []
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.on_tick = None
        self.discard = False

    def pump(self, deadline):
        require(time.monotonic() < deadline, "child phase deadline exhausted")
        if self.on_tick:
            self.on_tick()
        for key, _ in self.selector.select(min(0.1, max(0, deadline - time.monotonic()))):
            data = os.read(key.fileobj.fileno(), 65536)
            if not data:
                self.selector.unregister(key.fileobj)
                key.fileobj.close()
                continue
            if self.discard:
                continue
            if key.data == "stdout" and self.framed:
                self.buffer.extend(data)
                self.events.extend(decode_frames(self.buffer))
                require(len(self.events) <= 256, "helper event queue exceeded its bound")
            else:
                target = self.stdout if key.data == "stdout" else self.stderr
                target.extend(data)
                del target[:-65536]
                if not self.framed:
                    stream = sys.stdout.buffer if key.data == "stdout" else sys.stderr.buffer
                    stream.write(data)
                    stream.flush()

    def send(self, value, deadline):
        data = memoryview(frame(value))
        while data:
            require(time.monotonic() < deadline, "helper stdin deadline exhausted")
            try:
                data = data[os.write(self.process.stdin.fileno(), data):]
            except BlockingIOError:
                self.pump(deadline)

    def event(self, deadline):
        while not self.events:
            require(self.selector.get_map(), "helper exited before its terminal event: " + self.stderr.decode(errors="replace"))
            self.pump(deadline)
        return self.events.pop(0)

    def group_exists(self):
        try:
            os.killpg(self.group, 0)
            return True
        except ProcessLookupError:
            return False

    def joined(self):
        return self.process.poll() is not None and not self.selector.get_map() and not self.group_exists()

    def join(self, deadline):
        while not self.joined():
            self.pump(deadline)
        require(not self.buffer and not self.events, "unconsumed helper output at process retirement")
        return self.process.returncode

    def retire(self, cleanup_end):
        # A failed decoder/cache assertion must not prevent process-tree cleanup.
        self.on_tick = None
        self.discard = True
        self.process.stdin.close()
        for sig, seconds in [(None, 15), (signal.SIGTERM, 10), (signal.SIGKILL, 5)]:
            if self.joined():
                break
            if sig is not None and self.group_exists():
                os.killpg(self.group, sig)
            deadline = min(cleanup_end, time.monotonic() + seconds)
            while time.monotonic() < deadline and not self.joined():
                try:
                    self.pump(deadline)
                except RuntimeError:
                    if time.monotonic() < deadline:
                        raise
        self.process.poll()
        require(self.joined(), "owned process group or pipes could not be retired; retaining scratch")
        self.selector.close()


class Proof:
    def __init__(self, checkout, scratch, proof_dir, budget):
        self.checkout, self.scratch, self.proof_dir, self.budget = checkout, scratch, proof_dir, budget
        self.children = []
        self.result = {
            "version": 1, "phases": [], "variants": {}, "requests": [], "complete": False,
            "generation": {"text": TEXT, "activeText": ACTIVE_TEXT, "defaultMaxTokensPerSentence": 1200, "parameterOverrides": False},
        }
        self.phase = "initialization"
        self.cache_root = scratch / "model-caches"
        self.cache_root.mkdir()
        self.env = {key: os.environ[key] for key in ["HOME", "PATH", "DEVELOPER_DIR", "SDKROOT", "TOOLCHAINS", "LANG", "LC_ALL"] if key in os.environ}
        self.env.update({"CI": "true", "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1"})

    def begin(self, name):
        self.phase = name
        self.result["phases"].append({"name": name, "started": time.monotonic()})
        print(f"[mlx-native] {name}", flush=True)

    def command(self, argv, seconds, cwd=None, env=None):
        child = Child(argv, cwd or self.checkout, env or self.env)
        self.children.append(child)
        try:
            code = child.join(self.budget.deadline(seconds))
            require(code == 0, f"{self.phase}: command failed (exit {code}): {child.stderr.decode(errors='replace')}")
            return child.stdout.decode().strip()
        finally:
            child.retire(self.budget.cleanup_end)

    def git(self, *args):
        return self.command(["git", *args], 30)

    def verify_source(self, source, revision):
        require(self.command(["git", "rev-parse", "HEAD"], 30, source) == revision, "selected checkout HEAD mismatch")
        blobs = {p: self.command(["git", "rev-parse", f"{revision}:{p}"], 30, source) for p in INPUTS}
        for p, expected in blobs.items():
            actual = self.command(["git", "hash-object", p], 30, source)
            require(actual == expected, f"selected helper input differs: {p}")
        return {"sha": revision, "tree": self.command(["git", "rev-parse", f"{revision}^{{tree}}"], 30, source), "blobs": blobs}

    def snapshot(self, name, revision):
        self.begin(f"{name}: immutable source acquisition")
        # Add objects only. Never rewrite a branch, FETCH_HEAD, or shared worktree.
        exists = subprocess.run(["git", "cat-file", "-e", revision + "^{commit}"], cwd=self.checkout, env=self.env, capture_output=True).returncode == 0
        if not exists:
            self.command(["git", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "fetch", "--depth=1", "--no-auto-maintenance", "--no-write-commit-graph", "--no-tags", "--no-prune", "--no-prune-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=", "https://github.com/openclaw/openclaw.git", revision], 120)
        target = self.scratch / name
        target.mkdir()
        entries = self.git("ls-tree", "-r", revision, "--", PACKAGE, PROTOCOL).splitlines()
        blobs = {}
        # Export verified regular source files, not a mutable replacement manifest.
        for entry in entries:
            metadata, relative = entry.split("\t", 1)
            mode, kind, blob = metadata.split()
            require(kind == "blob" and mode in ["100644", "100755"], "unexpected snapshot entry")
            path = target / relative
            require(path.resolve().is_relative_to(target.resolve()), "snapshot path escapes owned root")
            path.parent.mkdir(parents=True, exist_ok=True)
            data = subprocess.run(["git", "cat-file", "blob", blob], cwd=self.checkout, env=self.env, capture_output=True, check=True).stdout
            require(len(data) <= 1024 * 1024, "snapshot file exceeds scoped source bound")
            require(hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() == blob, "snapshot blob mismatch")
            path.write_bytes(data)
            path.chmod(int(mode, 8) & 0o777)
            blobs[relative] = blob
        require(all(p in blobs for p in INPUTS), "incomplete helper snapshot")
        self.result["variants"][name] = {"sha": revision, "tree": self.git("rev-parse", revision + "^{tree}"), "blobs": blobs}
        return target

    def build(self, name, source):
        self.begin(f"{name}: resolve and build")
        package = source / PACKAGE
        manifest, lock = package / "Package.swift", package / "Package.resolved"
        before = {"manifest": digest(manifest), "lock": digest(lock)}
        build = self.scratch / (name + "-build")
        self.command(["swift", "package", "--package-path", package, "--scratch-path", build, "resolve"], 120)
        after = {"manifest": digest(manifest), "lock": digest(lock)}
        info = self.result["variants"][name]
        info.update({"before": before, "resolved": after, "pins": json.loads(lock.read_text())["pins"]})
        expected_audio = {
            "stable": "3506fb93cc3b9e4a642079d5384eaca0373962e6",
            "bad": "6fd938669e45412f5c35e011e7086ecd20397dbd",
        }.get(name)
        if expected_audio:
            audio = next(pin for pin in info["pins"] if pin["identity"] == "mlx-audio-swift")
            require(audio["state"]["revision"] == expected_audio, f"{name}: wrong audio dependency baseline")
        if name == "fixed":
            for path in [manifest, lock]:
                shutil.copyfile(path, self.proof_dir / path.name)
            (self.proof_dir / "SHA256SUMS").write_text(f"{after['manifest']}  Package.swift\n{after['lock']}  Package.resolved\n")
        # A resolver mismatch is a setup failure, never the expected bad-cache red.
        info["committedResolutionMatches"] = before == after
        if name != "fixed":
            require(before == after, f"{name}: committed resolution changed")
        args = ["swift", "build", "--build-system", "swiftbuild", "--package-path", package, "-c", "debug", "--product", "openclaw-mlx-tts", "--build-path", build, "--arch", "arm64", "--jobs", "1"]
        started = time.monotonic()
        self.command(args, 480)
        binary_dir = Path(self.command(args + ["--show-bin-path"], 30).splitlines()[-1])
        require(binary_dir.resolve().is_relative_to(build.resolve()), "Swift bin directory escapes owned build")
        binary = binary_dir / "openclaw-mlx-tts"
        library = binary_dir / "mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib"
        require(library.stat().st_size > 0, "missing MLX Metal resource")
        info.update({"buildSeconds": time.monotonic() - started, "binarySHA256": digest(binary), "metallibSHA256": digest(library)})
        probe_source = build / "metal-capability.swift"
        probe_source.write_text(METAL_SOURCE)
        probe = build / "metal-capability"
        self.command(["swiftc", "-framework", "Metal", "-framework", "CoreGraphics", probe_source, "-o", probe], 60)
        self.command([probe, library, "optional"], 30)
        if name == "fixed":
            self.command(["swift", "test", "--build-system", "swiftbuild", "--package-path", package, "-c", "debug", "--build-path", build, "--arch", "arm64", "--jobs", "1", "--filter", "MLXTTSHelperServiceTests"], 120)
        require(before == {"manifest": digest(manifest), "lock": digest(lock)}, f"{name}: inputs changed during build/tests")
        return binary, library, probe

    def isolated_env(self, home, hub):
        home.mkdir(parents=True, exist_ok=True)
        tmp = home / "tmp"
        tmp.mkdir(exist_ok=True)
        return {**self.env, "HOME": str(home), "CFFIXED_USER_HOME": str(home), "TMPDIR": str(tmp), "HF_HOME": str(home / "hf"), "HF_HUB_CACHE": str(hub)}

    def sandbox(self, argv, online=False):
        profile = self.checkout / "scripts/macos-health-render.sb"
        if online:
            # Permit cold download without dropping the existing home/Keychain policy.
            source = profile.read_bytes()
            network_deny = b"(deny network*)\n"
            require(source.count(network_deny) == 1, "online profile requires exactly one network denial")
            profile = self.scratch / "online.sb"
            profile.write_bytes(source.replace(network_deny, b"", 1))
            self.result["coldIsolation"] = {
                "profileSHA256": digest(profile),
                "baseProfileSHA256": hashlib.sha256(source).hexdigest(),
                "policy": "owned HF cache and narrow environment; original-home and named Keychain/IPC restrictions retained",
                "hostAssumption": "disposable canonical org-CI account",
                "sharedOSStoreIsolationProven": False,
            }
        return ["/usr/bin/sandbox-exec", "-D", "ORIGINAL_HOME=" + os.environ["HOME"], "-D", "REPO=" + str(self.checkout), "-D", "ISOLATED_ROOT=" + str(self.scratch), "-f", profile, *argv]

    def controls(self, variant):
        self.begin("offline sandbox network and Metal controls")
        binary, library, probe = variant
        env = self.isolated_env(self.scratch / "controls-home", self.cache_root / "controls")
        # Keep this listener open across all controls; no socket crosses close_fds.
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen(4)
            port = server.getsockname()[1]
            script = "import socket; s=socket.create_connection(('127.0.0.1'," + str(port) + "),timeout=3); s.close()"
            self.command([sys.executable, "-I", "-S", "-c", script], 10, env=env)
            negative = "import socket\ntry:\n s=socket.create_connection(('127.0.0.1'," + str(port) + "),timeout=3)\nexcept PermissionError:\n print('network-denied')\nelse:\n s.close(); raise SystemExit('sandbox allowed network')"
            require(self.command(self.sandbox([sys.executable, "-I", "-S", "-c", negative]), 10, env=env) == "network-denied", "offline denial control failed")
            self.command([sys.executable, "-I", "-S", "-c", script], 10, env=env)
            self.command(self.sandbox([sys.executable, "-I", "-S", "-c", script], online=True), 10, env=env)
        output = self.command(self.sandbox([probe, library, "required"]), 30, env=env)
        require("MLX Metal device:" in output and "MLX Metal library: available" in output, "sandboxed Metal admission failed")
        return {"network": "positive/denied/positive", "onlineProfileNetwork": "positive", "metal": output}

    def cache_size(self):
        paths = list(self.cache_root.rglob("*"))
        require(all(p.resolve().is_relative_to(self.cache_root.resolve()) for p in paths), "cache entry escapes owned root")
        size = sum(p.stat().st_size for p in paths if p.is_file())
        self.result["maxCacheBytes"] = max(size, self.result.get("maxCacheBytes", 0))
        require(size <= CACHE_LIMIT, "model cache exceeded 2 GiB")

    def model_files(self, root):
        result = {}
        for name, (size, expected) in FILES.items():
            p = root / name
            require(p.resolve().is_relative_to(self.cache_root.resolve()), "model file escapes owned cache")
            require(p.is_file() and p.stat().st_size == size, "model file size mismatch: " + name)
            if name == "model.safetensors":
                actual = digest(p)
            else:
                actual = hashlib.sha1(f"blob {size}\0".encode() + p.read_bytes()).hexdigest()
            require(actual == expected, "model file identity mismatch: " + name)
            result[name] = {"bytes": size, "digest": actual, "algorithm": "sha256" if name == "model.safetensors" else "git-blob-sha1"}
        return result

    def helper(self, name, variant, hub, offline=True):
        env = self.isolated_env(self.scratch / (name + "-home"), hub)
        argv = self.sandbox([variant[0]], online=not offline)
        child = Child(argv, self.checkout, env, framed=True)
        child.on_tick = self.cache_size
        self.children.append(child)
        require(child.event(self.budget.deadline(30)) == {"type": "ready"}, "helper did not become ready")
        return child

    def request(self, child, name, stream=False, text=TEXT):
        child.send({"type": "synthesize", "synthesize": {"id": name, "text": text, "modelRepo": MODEL, "stream": stream}}, self.budget.deadline(10))

    def receive(self, child, deadline):
        self.cache_size()
        return child.event(deadline)

    def pcm(self, child, name, stream=False, seconds=120):
        self.request(child, name, stream)
        deadline = self.budget.deadline(seconds)
        total, nonzero, started = 0, False, False
        checksum, events = hashlib.sha256(), []
        while True:
            event = self.receive(child, deadline)
            kind = event.get("type")
            body = event.get(kind, event)
            require(body.get("id") == name, "unexpected helper response ID")
            events.append(kind)
            if kind == "stream_started":
                require(stream and not started, "unexpected stream start")
                require((body.get("format"), body.get("sampleRate"), body.get("channels")) == ("pcm_s16le", 32000, 1), "invalid stream format")
                started = True
            elif kind in ["audio", "audio_chunk"]:
                require(kind == ("audio_chunk" if stream else "audio"), "wrong audio response kind")
                if stream:
                    require(started, "audio preceded stream start")
                else:
                    require((body.get("format"), body.get("sampleRate"), body.get("channels")) == ("pcm_s16le", 32000, 1), "invalid PCM format")
                data = base64.b64decode(body["pcm"], validate=True)
                require(data and len(data) % 2 == 0, "empty or odd PCM payload")
                total += len(data)
                require(total <= PCM_LIMIT, "PCM exceeded request bound")
                nonzero |= any(data)
                checksum.update(data)
                if not stream:
                    break  # The real nonstreaming terminal event is audio, not completed.
            elif kind == "completed":
                require(stream and started, "unexpected completion")
                break
            else:
                raise RuntimeError("synthesis failed: " + json.dumps(event))
        require(total and nonzero, "PCM contains no nonzero sample")
        self.result["requests"].append({"id": name, "events": events, "pcmBytes": total, "pcmSHA256": checksum.hexdigest()})

    def active_cancel(self, child, name, shutdown=False):
        deadline = self.budget.deadline(30)
        self.request(child, name, text=ACTIVE_TEXT)
        self.request(child, name + "-busy")
        busy = self.receive(child, deadline)
        require(busy.get("type") == "error" and busy.get("error", {}).get("code") == "busy" and busy["error"].get("id") == name + "-busy", "active request completed before matching busy observation")
        # A busy response proves active ownership, not that GPU kernels have begun.
        child.send({"type": "shutdown"} if shutdown else {"type": "cancel", "id": name}, deadline)
        require(self.receive(child, deadline) == {"type": "canceled", "id": name}, "active request was not canceled before producing audio")
        self.result["requests"].append({"id": name, "events": ["busy", "canceled"], "kernelInterruptionProven": False})
        if shutdown:
            require(child.join(deadline) == 0, "shutdown did not exit cleanly")

    def stop_helper(self, child):
        child.send({"type": "shutdown"}, self.budget.deadline(10))
        require(child.join(self.budget.deadline(15)) == 0, "helper shutdown failed")

    def extended(self, fixed):
        self.result["controls"] = {"fixed": self.controls(fixed)}
        self.begin("fixed: real empty-cache online bootstrap (not offline proof)")
        # The native helper has no revision argument. Bind both sides of its main lookup.
        with urllib.request.urlopen(f"https://huggingface.co/api/models/{MODEL}/revision/main", timeout=10) as response:
            metadata = response.read(1024 * 1024 + 1)
        require(len(metadata) <= 1024 * 1024 and json.loads(metadata)["sha"] == REVISION, "public model main moved")
        cold = self.cache_root / "cold"
        cold.mkdir()
        child = self.helper("cold", fixed, cold, offline=False)
        self.pcm(child, "cold-native-download", seconds=240)
        self.stop_helper(child)
        model_root = cold / "mlx-audio/mlx-community_Soprano-80M-bf16"
        require(json.loads((model_root / ".mlx-audio-snapshot.json").read_text())["revision"] == REVISION, "native snapshot revision mismatch")
        self.result["model"] = {"repo": MODEL, "revision": REVISION, "license": "Apache-2.0", "files": self.model_files(model_root)}
        legacy = self.cache_root / "stable-used/mlx-audio/mlx-community_Soprano-80M-bf16"
        bad_legacy = self.cache_root / "bad/mlx-audio/mlx-community_Soprano-80M-bf16"
        for target in [legacy, bad_legacy]:
            target.mkdir(parents=True)
            for name in FILES:
                shutil.copyfile(model_root / name, target / name)
            self.model_files(target)
        self.result["legacyFixture"] = "six verified native-downloaded files; not a stable-created download; no snapshot/HTTP metadata"
        self.cache_size()
        for name, revision in [("stable", STABLE), ("bad", BAD)]:
            source = self.snapshot(name, revision)
            variant = self.build(name, source)
            self.result["controls"][name] = self.controls(variant)
            self.begin(name + ": legacy cache under enforced offline boundary")
            hub = legacy.parent.parent if name == "stable" else bad_legacy.parent.parent
            child = self.helper(name, variant, hub)
            if name == "stable":
                self.pcm(child, "stable-offline")
            else:
                self.request(child, "bad-offline")
                event = self.receive(child, self.budget.deadline(120))
                self.result["badCacheRed"] = denied_cache_error(event)
            self.stop_helper(child)
            self.model_files(legacy if name == "stable" else bad_legacy)
        self.begin("fixed: retained stable-used offline cache and real lifecycle")
        child = self.helper("fixed-offline", fixed, legacy.parent.parent)
        self.pcm(child, "fixed-retained-offline")
        self.pcm(child, "fixed-stream", stream=True)
        self.active_cancel(child, "fixed-cancel")
        self.pcm(child, "fixed-after-cancel")
        self.active_cancel(child, "fixed-shutdown", shutdown=True)
        self.model_files(legacy)
        self.result["offlineHelperCacheComplete"] = True
        self.result["settingsUpgradeComplete"] = False

    def execute(self, extended):
        revision = os.environ["CHECKOUT_SHA"]
        require(re.fullmatch(r"[0-9a-f]{40}", revision), "invalid selected checkout SHA")
        self.result.update({"source": self.verify_source(self.checkout, revision), "workflowSHA": os.environ.get("GITHUB_WORKFLOW_SHA"), "triggerSHA": os.environ.get("GITHUB_SHA"), "run": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"], "extended": extended})
        self.result["variants"]["fixed"] = dict(self.result["source"])
        (self.proof_dir / "source.txt").write_text(f"source_sha={revision}\nrun_id={os.environ['GITHUB_RUN_ID']}\nrun_attempt={os.environ['GITHUB_RUN_ATTEMPT']}\njob={os.environ['GITHUB_JOB']}\n")
        fixed = self.build("fixed", self.checkout)
        if extended:
            self.extended(fixed)
        self.result["complete"] = True

    def close(self):
        joined = True
        for child in self.children:
            try:
                child.retire(self.budget.cleanup_end)
            except Exception as error:
                joined = False
                self.result.setdefault("cleanupErrors", []).append(str(error))
        self.result["processesAndPipesRetired"] = joined
        if joined:
            shutil.rmtree(self.scratch)
        self.result["scratchRemoved"] = joined
        self.result["complete"] = self.result["complete"] and joined
        # No model weights, audio, tokens, raw HOME, or unbounded logs become artifacts.
        payload = json.dumps(self.result, indent=2, sort_keys=True).replace(str(self.scratch), "<owned-scratch>").replace(str(self.checkout), "<checkout>").replace(os.environ["HOME"], "<runner-home>")
        require(len(payload.encode()) <= 128 * 1024, "native proof metadata exceeded artifact bound")
        (self.proof_dir / "native-proof.json").write_text(payload + "\n")
        require(joined, "native proof cleanup is incomplete")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proof-dir", type=Path, required=True)
    parser.add_argument("--started", type=float, required=True)
    parser.add_argument("--extended", action="store_true")
    args = parser.parse_args()
    require(sys.platform == "darwin" and os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REPOSITORY") == "openclaw/openclaw", "native MLX proof requires disposable canonical macOS CI")
    require(not args.extended or os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "extended model proof requires admitted manual CI")
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    proof_dir = args.proof_dir.resolve(strict=True)
    require(proof_dir.is_relative_to(runner_temp) and proof_dir != runner_temp and not args.proof_dir.is_symlink(), "proof directory is not owned runner scratch")
    budget = Budget(args.started)
    scratch = Path(tempfile.mkdtemp(prefix="openclaw-mlx-native-", dir=runner_temp)).resolve()
    proof = Proof(Path.cwd().resolve(), scratch, proof_dir, budget)
    previous = signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        proof.execute(args.extended)
    except BaseException as error:
        proof.result["failure"] = {"phase": proof.phase, "detail": str(error)}
        raise
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            proof.close()
        finally:
            signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        print(f"[mlx-native] FAILED (exit 1): {error}", file=sys.stderr)
        sys.exit(1)
