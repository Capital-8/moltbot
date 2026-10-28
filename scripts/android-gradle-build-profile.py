#!/usr/bin/env python3
"""One secretless, build-only profile of the pinned Android release source."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

ROOT = Path.cwd()
ANDROID = ROOT / "apps/android"
OUT = Path(os.environ["PROFILE_OUTPUT"])
SOURCE = "60b52d9d21d13599c7abd4851e9cdbf4532e3445"
VERSION = "2026.10.80"
PHONE_CODE = "2026090518"
WEAR_CODE = "2026090519"


def git(*args):
    return subprocess.check_output(["git", *args], text=True, cwd=ROOT).strip()


def verify_source():
    if git("rev-parse", "HEAD") != SOURCE or os.environ["PROFILE_SOURCE_SHA"] != SOURCE:
        raise ValueError("Profile must execute the exact selected production source")
    if git("status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Production source must remain clean")


def sample():
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
            memory[key + "KiB"] = int(value.split()[0])
    return {
        "monotonicSeconds": time.monotonic(),
        "cpuJiffies": [int(value) for value in Path("/proc/stat").read_text().splitlines()[0].split()[1:]],
        "memory": memory,
        "loadAverage": list(os.getloadavg()),
    }


def measure(name, args, env):
    directory = OUT / name
    directory.mkdir()
    stopped = threading.Event()
    samples = []

    def monitor():
        while not stopped.is_set():
            samples.append(sample())
            stopped.wait(5)

    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    started = time.monotonic()
    command = ["./gradlew", "--profile", *args]
    print(f"Starting {name}", flush=True)
    try:
        with (directory / "gradle.log").open("w") as log:
            result = subprocess.run(command, cwd=ANDROID, env=env, stdout=log, stderr=subprocess.STDOUT)
    finally:
        elapsed = time.monotonic() - started
        stopped.set()
        thread.join()
    samples.append(sample())
    profile = ANDROID / "build/reports/profile"
    if profile.is_dir():
        shutil.copytree(profile, directory / "gradle-profile")
    facts = {"command": command, "elapsedSeconds": elapsed, "exitStatus": result.returncode, "hostSamples": samples}
    (directory / "result.json").write_text(json.dumps(facts, indent=2) + "\n")
    print(f"Finished {name}: status={result.returncode}, wall={elapsed:.3f}s", flush=True)
    if result.returncode:
        raise RuntimeError(f"{name} failed; inspect its retained gradle.log")
    if not list((directory / "gradle-profile").glob("*.html")):
        raise RuntimeError(f"{name} did not produce a local Gradle profile")
    return facts


def main():
    verify_source()
    if Path(os.environ["GRADLE_USER_HOME"]).exists():
        raise ValueError("Profile requires a never-used Gradle user home")
    OUT.mkdir(exist_ok=False)
    facts = {
        "sourceSha": SOURCE,
        "toolingSha": os.environ["GITHUB_SHA"],
        "version": VERSION,
        "phoneVersionCode": PHONE_CODE,
        "wearVersionCode": WEAR_CODE,
        "signing": "Disposable synthetic key; no store credentials or publishing commands",
        "cpuCount": os.cpu_count(),
        "cpuAffinity": sorted(os.sched_getaffinity(0)),
        "cpuModel": next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")), "unknown"),
        "expectedCpus": int(os.environ["PROFILE_EXPECTED_CPUS"]),
        "variant": os.environ["PROFILE_VARIANT"],
        "sample": int(os.environ["PROFILE_SAMPLE"]),
        "runnerLabel": os.environ["PROFILE_RUNNER_LABEL"],
        "toolVersions": {name: subprocess.check_output(command, text=True, stderr=subprocess.STDOUT).strip() for name, command in {"node": ["node", "--version"], "java": ["java", "-version"]}.items()},
        "runner": {key: os.environ.get(key) for key in ["RUNNER_NAME", "RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion"]},
        "cgroup": {name: (Path("/sys/fs/cgroup") / name).read_text().strip() for name in ["cpu.max", "memory.max", "cpuset.cpus.effective"] if (Path("/sys/fs/cgroup") / name).is_file()},
        "hostBefore": sample(),
        "status": "failed",
    }
    keystore = Path(os.environ["RUNNER_TEMP"]) / "android-profile-fixture.p12"
    if keystore.exists():
        raise ValueError("Synthetic signing path must be unused")
    env = dict(os.environ)
    for key in ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]:
        env.pop(key, None)
    env.update({
        "LC_ALL": "C", "LANG": "C",
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_FILE": str(keystore),
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_PASSWORD": "android",
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_ALIAS": "profile",
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_PASSWORD": "android",
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_VERSION_NAME": VERSION,
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_VERSION_CODE": PHONE_CODE,
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_WEAR_VERSION_CODE": WEAR_CODE,
    })
    try:
        if min(facts["cpuCount"], len(facts["cpuAffinity"])) != facts["expectedCpus"]:
            raise ValueError("Runner CPU allocation does not match the selected comparison arm")
        subprocess.run(["keytool", "-genkeypair", "-storetype", "PKCS12", "-keystore", str(keystore), "-storepass", "android", "-keypass", "android", "-alias", "profile", "-keyalg", "RSA", "-keysize", "2048", "-validity", "2", "-dname", "CN=Disposable Android Build Profile"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        keystore.chmod(0o600)
        facts["signingPreflight"] = measure("signing-preflight", [
            ":app:validateSigningPlayRelease", ":wear:validateSigningRelease",
            "-PopenclawBuildCommit=" + SOURCE, "-PopenclawBuildTimestamp=2026-10-28T18:59:14Z",
        ], env)
        verify_source()
        facts["build"] = measure("bundle-build", [
            "-PopenclawBuildCommit=" + SOURCE, "-PopenclawBuildTimestamp=2026-10-28T19:00:37.454Z",
            "-POPENCLAW_ANDROID_VERSION_NAME=" + VERSION,
            "-POPENCLAW_ANDROID_VERSION_CODE=" + PHONE_CODE,
            "-POPENCLAW_ANDROID_WEAR_VERSION_CODE=" + WEAR_CODE,
            ":wear:bundleRelease", ":app:bundlePlayRelease",
        ], env)
        facts["artifacts"] = []
        for relative in ["wear/build/outputs/bundle/release/wear-release.aab", "app/build/outputs/bundle/playRelease/app-play-release.aab"]:
            artifact = ANDROID / relative
            subprocess.run(["jarsigner", "-verify", str(artifact)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            facts["artifacts"].append({"path": relative, "bytes": artifact.stat().st_size, "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()})
        verify_source()
        facts["status"] = "passed"
    finally:
        with (OUT / "daemon-stop.log").open("w") as log:
            subprocess.run(["./gradlew", "--stop"], cwd=ANDROID, env=env, stdout=log, stderr=subprocess.STDOUT)
        keystore.unlink(missing_ok=True)
        (OUT / "proof.json").write_text(json.dumps(facts, indent=2) + "\n")


if __name__ == "__main__":
    main()
