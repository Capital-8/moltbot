"""Temporary simulator accounting probe; no build, signing, upload, or process scans."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time


COUNTERS = {
    "maximum resident set size": "maxResidentBytes",
    "page reclaims": "pageReclaims",
    "page faults": "pageFaults",
    "swaps": "swaps",
    "block input operations": "blockInputOperations",
    "block output operations": "blockOutputOperations",
    "voluntary context switches": "voluntaryContextSwitches",
    "involuntary context switches": "involuntaryContextSwitches",
    "instructions retired": "instructionsRetired",
    "cycles elapsed": "cyclesElapsed",
    "peak memory footprint": "peakMemoryFootprintBytes",
}


def accounting(raw):
    result = {}
    for line in raw.splitlines():
        match = re.fullmatch(r"(real|user|sys) ([0-9.]+)", line.strip())
        if match:
            name = {"real": "realSeconds", "user": "userSeconds", "sys": "systemSeconds"}[match[1]]
            result[name] = float(match[2])
        else:
            match = re.fullmatch(r"\s*(\d+)\s+(.+)", line)
            if match and match[2] in COUNTERS:
                result[COUNTERS[match[2]]] = int(match[1])
    if not {"realSeconds", "userSeconds", "systemSeconds"} <= result.keys():
        raise RuntimeError("Native time did not provide elapsed, user, and system accounting")
    result["accountedCpuSeconds"] = round(result["userSeconds"] + result["systemSeconds"], 4)
    result["averageAccountedCpuCores"] = (
        round(result["accountedCpuSeconds"] / result["realSeconds"], 4)
        if result["realSeconds"] else None
    )
    return result


class Probe:
    def __init__(self, output):
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)
        self.records = []
        (self.output / "scope.json").write_text(json.dumps({
            "cpuCount": os.cpu_count(),
            "accountingScope": "command and waited-for descendants; excludes external CoreSimulator services",
            "globalProcessScans": False,
            "stackSampling": False,
        }, indent=2) + "\n")

    def run(self, label, arguments, *, timeout=180):
        started_at = datetime.now(timezone.utc).isoformat()
        load_before = os.getloadavg()
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="ios-native-accounting-") as directory:
            report = Path(directory) / "time.txt"
            child = subprocess.Popen(
                ["/usr/bin/time", "-lp", "-o", str(report), *arguments],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={**os.environ, "LC_ALL": "C"}, start_new_session=True,
            )
            spawned = time.monotonic()
            timed_out = False
            try:
                stdout, stderr = child.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(child.pid, signal.SIGKILL)
                stdout, stderr = child.communicate()
            elapsed = time.monotonic() - started
            record = {
                "label": label,
                "startedAt": started_at,
                "seconds": round(elapsed, 4),
                "spawnSeconds": round(spawned - started, 4),
                "exitCode": child.returncode,
                "timedOut": timed_out,
                "stdoutBytes": len(stdout),
                "stderrBytes": len(stderr),
                "loadBefore": load_before,
                "loadAfter": os.getloadavg(),
                "accounting": None if timed_out else accounting(report.read_text()),
            }
        self.records.append(record)
        (self.output / "timings.json").write_text(json.dumps(self.records, indent=2) + "\n")
        print(json.dumps(record), flush=True)
        if timed_out or child.returncode:
            raise RuntimeError(f"{label} {'exceeded the diagnostic deadline' if timed_out else 'failed with exit ' + str(child.returncode)}")
        return stdout.decode()

    def inventory(self, label):
        raw = self.run(label, ["xcrun", "simctl", "list", "devices", "available", "--json"])
        return [device for devices in json.loads(raw)["devices"].values() for device in devices]


def exclusive(devices, identifier):
    active = [device for device in devices if device["state"] != "Shutdown"]
    if len(active) != 1 or active[0]["udid"] != identifier or active[0]["state"] != "Booted":
        raise RuntimeError("The task-owned simulator is not the only active, Booted simulator")


def main(output):
    probe = Probe(output)
    probe.run("resolve-simctl", ["xcrun", "--find", "simctl"])
    templates = probe.inventory("initial-inventory")
    if any(device["state"] != "Shutdown" for device in templates):
        raise RuntimeError("Unrelated active simulator; nothing will be changed")
    flags = ["--time", "09:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
             "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100"]
    for family, name in [("iphone", "iPhone 18 Pro Max"), ("ipad", "iPad Pro 13-inch (M5)")]:
        template = next(device for device in templates if device["name"] == name)
        if any(device["state"] != "Shutdown" for device in probe.inventory(f"{family}-idle")):
            raise RuntimeError("Unrelated active simulator; stopping")
        probe.run(f"{family}-headroom", ["node", "scripts/lib/ios-simulator-headroom.ts"], timeout=310)
        identifier = probe.run(f"{family}-create", [
            "xcrun", "simctl", "create", f"OpenClaw accounting probe {family}",
            template["deviceTypeIdentifier"], "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
        ]).strip()
        try:
            probe.run(f"{family}-boot", ["xcrun", "simctl", "bootstatus", identifier, "-b"])
            exclusive(probe.inventory(f"{family}-fresh-inventory"), identifier)
            probe.run(f"{family}-fresh-status-bar", ["xcrun", "simctl", "status_bar", identifier, "override", *flags])
            exclusive(probe.inventory(f"{family}-later-inventory"), identifier)
            probe.run(f"{family}-later-status-bar", ["xcrun", "simctl", "status_bar", identifier, "override", *flags])
        finally:
            try:
                probe.run(f"{family}-shutdown", ["xcrun", "simctl", "shutdown", identifier])
            finally:
                probe.run(f"{family}-delete", ["xcrun", "simctl", "delete", identifier])
        if any(device["state"] != "Shutdown" for device in probe.inventory(f"{family}-cleaned-up")):
            raise RuntimeError("Simulator cleanup did not leave the host idle")


if __name__ == "__main__":
    main(sys.argv[1])
