// Temporary, read-only hosted diagnostic. libproc is SDK-declared but private;
// this is not a production API dependency. Never emit process paths or arguments.
#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

static const char *role(const struct proc_bsdinfo *info) {
  static const char *const names[] = {
      "launchd", "launchd_sim", "diagnosticd", "logd", "log", "Console",
      "mds", "mds_stores", "mdworker_shared", "CoreSpotlightService",
      "SpringBoard", "backboardd", "runningboardd", "mobileassetd",
      "intelligenceplatformd", "intelligencecontextd", "intelligenceflowd",
      "intelligencetasksd", "generativeexperiencesd", "modelcatalogd",
      "modelmanagerd", "STExtractionService", "amsengagementd", "apsd",
      "trustd", "securityd", "cfprefsd", "notifyd", "containermanagerd",
      "installd", "installcoordinationd", "lsd", "ReportCrash", "simctl",
      "Simulator", "SimulatorTrampoline", "SimulatorBridge", "simulatord",
      "simdiskimaged", "logd_helper", "logd_reporter", "osanalyticshelper",
      "photoanalysisd", "mediaanalysisd", "assetsd", "UserEventAgent",
      "node", "ruby", "xcodebuild", "SWBBuildService", "XCBBuildService",
      "testmanagerd", "xctest", "OpenClaw", "OpenClawUITests-Runner",
      "WindowServer", "kernel_task", "launchd_sim_trampoline"};
  char name[sizeof(info->pbi_name) + 1] = {0};
  memcpy(name, info->pbi_name[0] ? info->pbi_name : info->pbi_comm,
         info->pbi_name[0] ? sizeof(info->pbi_name) : sizeof(info->pbi_comm));
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    if (strcmp(name, names[i]) == 0) return names[i];
  }
  // BSD names truncate at 32 bytes. Label this known prefix as a category only.
  if (strncmp(name, "com.apple.CoreSimulator.", 23) == 0) return "CoreSimulator-family";
  if (strcmp(name, "ios-startup-counters") == 0) return "observer";
  return "other";
}

int main(void) {
  alarm(2);
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) return 1;
  pid_t pids[4096];
  int count = proc_listallpids(pids, sizeof(pids));
  if (count <= 0 || count > 4096) return 1;
  int bsd_failures = 0, usage_failures = 0, emitted = 0;
  printf("{\"effectiveUid\":%d,\"listed\":%d,\"atCapacity\":%s,\"timebaseNumer\":%u,\"timebaseDenom\":%u,\"processes\":[",
         geteuid(), count, count == 4096 ? "true" : "false", timebase.numer, timebase.denom);
  for (int i = 0; i < count; i++) {
    if (pids[i] <= 0) continue;
    struct proc_bsdinfo info = {0};
    if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) {
      bsd_failures++;
      continue;
    }
    struct rusage_info_v2 usage = {0};
    int ok = proc_pid_rusage(pids[i], RUSAGE_INFO_V2, (rusage_info_t *)&usage) == 0;
    if (!ok) usage_failures++;
    printf("%s{\"pid\":%d,\"parentPid\":%u,\"role\":\"%s\",\"started\":\"%" PRIu64 ".%" PRIu64 "\",\"status\":%u,\"usage\":",
           emitted++ ? "," : "", pids[i], info.pbi_ppid, role(&info),
           info.pbi_start_tvsec, info.pbi_start_tvusec, info.pbi_status);
    if (ok) {
      printf("{\"cpuMs\":%.3f,\"residentBytes\":%" PRIu64 ",\"footprintBytes\":%" PRIu64 ",\"readBytes\":%" PRIu64 ",\"writtenBytes\":%" PRIu64 "}",
             ((double)usage.ri_user_time + (double)usage.ri_system_time) * timebase.numer / timebase.denom / 1e6,
             usage.ri_resident_size, usage.ri_phys_footprint,
             usage.ri_diskio_bytesread, usage.ri_diskio_byteswritten);
    } else {
      printf("null");
    }
    printf("}");
  }
  struct rusage self = {0};
  getrusage(RUSAGE_SELF, &self);
  printf("],\"bsdFailures\":%d,\"usageFailures\":%d,\"observerCpuMs\":%.3f}\n",
         bsd_failures, usage_failures,
         1000.0 * (self.ru_utime.tv_sec + self.ru_stime.tv_sec) +
             (self.ru_utime.tv_usec + self.ru_stime.tv_usec) / 1000.0);
  return ferror(stdout) ? 1 : 0;
}
