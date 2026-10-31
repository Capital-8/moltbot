require "timeout"
require "json"

# Temporary hosted-run evidence for the Watch boot shutdown investigation.
class WatchBootTrace
  PROCESSES = %w[CoreSimulatorService com.apple.CoreSimulator.CoreSimulatorService simdiskimaged SimLaunchHost.arm64 SimLaunchHost.x86_64 launchd_sim Carousel backboardd runningboardd watchdogd ReportCrash SimulatorTrampoline cryptexd].freeze
  HOST_PROCESSES = %w[CoreSimulatorService com.apple.CoreSimulator.CoreSimulatorService simdiskimaged SimLaunchHost.arm64 SimLaunchHost.x86_64 cryptexd ReportCrash].freeze

  def self.predicate
    hosts = HOST_PROCESSES.map { |name| %Q(\"#{name}\") }.join(",")
    guests = (PROCESSES - HOST_PROCESSES).map { |name| %Q(\"#{name}\") }.join(",")
    "process IN {#{hosts}} OR (process IN {#{guests}} AND (eventMessage CONTAINS[c] \"shutdown\" OR eventMessage CONTAINS[c] \"exited\" OR eventMessage CONTAINS[c] \"crash\" OR eventMessage CONTAINS[c] \"watchdog\" OR eventMessage CONTAINS[c] \"timed out\"))"
  end

  def self.read_logs(path)
    File.foreach(path).filter_map do |line|
      event = JSON.parse(line)
      next unless event["eventMessage"]
      { "timestamp" => event["timestamp"], "process" => File.basename(event["processImagePath"].to_s),
        "message" => event["eventMessage"].gsub(File.expand_path("~"), "<HOME>").gsub(%r{/Users/[^/\s]+}, "<HOME>")[0, 2000] }
    rescue JSON::ParserError
      nil
    end
  end

  def self.start(udid, runtime, output)
    trace = new(udid, runtime, output)
    trace.start
    trace
  rescue StandardError => error
    trace&.finish
    UI.important("Watch boot trace unavailable: #{error.class}")
    nil
  end

  def initialize(udid, runtime, output)
    @udid, @runtime, @output = udid, runtime, output
    @started = Time.now
    @facts = { "udid" => udid, "runtime" => runtime, "startedAt" => @started.utc.iso8601 }
  end

  def start
    @facts["before"] = snapshot
    @raw = Tempfile.new("watch-boot-log")
    @pid = Process.spawn("/usr/bin/log", "stream", "--style", "ndjson", "--level", "debug", "--predicate", self.class.predicate,
      out: @raw.path, err: File::NULL)
  end

  def finish
    @facts["after"] = snapshot
    stop
    @facts["logs"] = self.class.read_logs(@raw.path) if @raw
    @facts["deviceLogs"] = Dir[File.expand_path("~/Library/Logs/CoreSimulator/#{@udid}/*.log")].to_h do |path|
      [File.basename(path), File.readlines(path).last(200).map { |line| sanitize(line)[0, 2000] }]
    end
    @facts["crashes"] = crashes
    FileUtils.mkdir_p(File.dirname(@output))
    File.write(@output, JSON.pretty_generate(@facts))
  rescue StandardError => error
    UI.important("Watch boot trace collection failed: #{error.class}")
  ensure
    stop
    @raw&.close!
  end

  private

  def stop
    return unless @pid
    Process.kill("TERM", @pid)
    begin
      Timeout.timeout(5) { Process.wait(@pid) }
    rescue Timeout::Error
      Process.kill("KILL", @pid)
      Process.wait(@pid)
    end
    @pid = nil
  rescue Errno::ESRCH, Errno::ECHILD
    @pid = nil
  end

  def snapshot
    images, = Open3.capture3("xcrun", "simctl", "runtime", "list", "-j")
    runtimes, = Open3.capture3("xcrun", "simctl", "list", "runtimes", "--json")
    mounts, = Open3.capture3("/sbin/mount")
    memory, = Open3.capture3("vm_stat")
    swap, = Open3.capture3("sysctl", "-n", "vm.swapusage")
    {
      "at" => Time.now.utc.iso8601,
      "images" => JSON.parse(images).values.map do |entry|
        entry.slice("identifier", "runtimeIdentifier", "state", "version", "build").merge("mountedPathExists" => !!(entry["runtimeBundlePath"] && File.directory?(entry["runtimeBundlePath"])))
      end,
      "runtimes" => JSON.parse(runtimes).fetch("runtimes").map { |entry| entry.slice("identifier", "isAvailable", "version", "buildversion") },
      "mounts" => mounts.lines.grep(/CoreSimulator|cryptex.*(?:iOS|watchOS|tvOS|xrOS)/).map { |line| sanitize(line) },
      "vmStat" => memory, "swap" => swap
    }
  end

  def crashes
    directories = [File.expand_path("~/Library/Logs/DiagnosticReports"), "/Library/Logs/DiagnosticReports",
      File.expand_path("~/Library/Developer/CoreSimulator/Devices/#{@udid}/data/Library/Logs/CrashReporter")]
    directories.flat_map { |directory| Dir[File.join(directory, "**/*.ips")] }.filter_map do |path|
      next unless File.mtime(path) >= @started && File.size(path) < 10 * 1024 * 1024
      contents = File.read(path)
      report = begin
        JSON.parse(contents)
      rescue JSON::ParserError
        JSON.parse(contents.split("\n", 2).last)
      end
      next unless PROCESSES.include?(report["procName"])
      thread = Array(report["threads"]).find { |entry| entry["triggered"] }
      { "process" => report["procName"], "exception" => report.fetch("exception", {}).slice("type", "signal", "codes"),
        "termination" => report.fetch("termination", {}).slice("namespace", "code"),
        "frames" => Array(thread && thread["frames"]).first(12).map { |frame| sanitize(frame["symbol"].to_s)[0, 240] } }
    rescue JSON::ParserError, SystemCallError
      nil
    end
  end

  def sanitize(text)
    text.gsub(File.expand_path("~"), "<HOME>").gsub(%r{/Users/[^/\s]+}, "<HOME>")
  end
end

if $PROGRAM_NAME == __FILE__
  if ARGV == ["predicate"]
    puts WatchBootTrace.predicate
  else
    raw, output = ARGV
    File.write(output, JSON.pretty_generate({ "logs" => WatchBootTrace.read_logs(raw) }))
  end
end
