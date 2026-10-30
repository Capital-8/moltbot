# Temporary hosted diagnostic: export only fixed process roles and numeric counters.
import json
import os
import plistlib
import resource
import subprocess
import time
from xml.parsers.expat import ExpatError

ROLES = set(['launchd', 'launchd_sim', 'diagnosticd', 'logd', 'log', 'Console', 'mds', 'mds_stores', 'mdworker_shared', 'CoreSpotlightService', 'SpringBoard', 'backboardd', 'runningboardd', 'mobileassetd', 'intelligenceplatformd', 'intelligencecontextd', 'intelligenceflowd', 'intelligencetasksd', 'generativeexperiencesd', 'modelcatalogd', 'modelmanagerd', 'STExtractionService', 'amsengagementd', 'apsd', 'trustd', 'securityd', 'cfprefsd', 'notifyd', 'containermanagerd', 'installd', 'installcoordinationd', 'lsd', 'ReportCrash', 'simctl', 'Simulator', 'SimulatorTrampoline', 'SimulatorBridge', 'simulatord', 'simdiskimaged', 'logd_helper', 'logd_reporter', 'osanalyticshelper', 'photoanalysisd', 'mediaanalysisd', 'assetsd', 'UserEventAgent', 'node', 'ruby', 'xcodebuild', 'SWBBuildService', 'XCBBuildService', 'testmanagerd', 'xctest', 'OpenClaw', 'OpenClawUITests-Runner', 'WindowServer', 'kernel_task', 'launchd_sim_trampoline', 'DEAD_TASKS', 'ALL_TASKS', 'powermetrics'])
FIELDS = ("pid", "ppid", "responsible_pid", "cputime_ns", "cputime_ms_per_s",
          "cputime_sample_ms_per_s", "diskio_bytesread", "diskio_byteswritten",
          "intr_wakeups", "idle_wakeups")


def counters(row):
    return {key: row[key] for key in FIELDS
            if isinstance(row.get(key), (int, float)) and not isinstance(row.get(key), bool)}


started = time.monotonic()
result = {"outcome": "unrecognized", "effectiveUid": os.geteuid(), "tasks": []}
raw = b""
try:
    command = subprocess.run(
        ["/usr/bin/powermetrics", "--samplers", "tasks", "--format", "plist",
         "--sample-rate", "1000", "--sample-count", "1", "--order", "cputime",
         "--show-process-samp-norm", "--show-responsible-pid", "--show-process-io"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=4, check=False)
    raw = command.stdout
    result["returnCode"] = command.returncode
    if command.returncode:
        result["outcome"] = "command-failed"
except subprocess.TimeoutExpired as error:
    raw = error.stdout or b""
    result["outcome"] = "timeout"

# powermetrics emits NUL-separated plists. Keep complete records even after a
# command failure; incomplete/raw output and all string metadata stay private.
for chunk in raw.split(b"\0") if len(raw) <= 4 * 1024 * 1024 else []:
    if not chunk.strip():
        continue
    try:
        sample = plistlib.loads(chunk)
    except (ValueError, plistlib.InvalidFileException, ExpatError):
        continue
    if not isinstance(sample.get("elapsed_ns"), (int, float)) or not isinstance(sample.get("tasks"), list):
        continue
    result["elapsedNs"] = sample["elapsed_ns"]
    result["allTasks"] = counters(sample.get("all_tasks", {}))
    for row in sample["tasks"]:
        name = row.get("name")
        result["tasks"].append({"role": name if name in ROLES else "other", **counters(row)})
    if result.get("returnCode") == 0:
        result["outcome"] = "ok"

usage = resource.getrusage(resource.RUSAGE_CHILDREN)
result["childCpuMs"] = 1000 * (usage.ru_utime + usage.ru_stime)
result["wallMs"] = round(1000 * (time.monotonic() - started))
print(json.dumps(result, allow_nan=False))
