require "json"
require "open3"
require "fileutils"
require "time"
require "tempfile"
require "fastlane"
require_relative "watch_boot_trace"
require_relative "watch_runtime_admission"

UI = FastlaneCore::UI unless defined?(UI)

# Temporary, no-build reproduction of a Watch session overlapping runtime cleanup.
def command(*args)
  stdout, stderr, status = Open3.capture3(*args)
  raise "#{args.join(' ')} failed: #{stderr.strip}" unless status.success?
  stdout
end

output = File.expand_path("../build/watch-runtime-probe.json", __dir__)
facts = { "startedAt" => Time.now.utc.iso8601, "observations" => [] }
udid = nil
trace = nil
begin
  facts["imagesBefore"] = JSON.parse(command("xcrun", "simctl", "runtime", "list", "-j"))
  WatchRuntimeAdmission.wait!
  facts["admittedAt"] = Time.now.utc.iso8601
  runtimes = JSON.parse(command("xcrun", "simctl", "list", "runtimes", "--json")).fetch("runtimes")
  runtime = runtimes.select { |entry| entry["isAvailable"] && entry.fetch("identifier").include?(".watchOS-") }
    .max_by { |entry| Gem::Version.new(entry.fetch("version")) }
  raise "No available Watch runtime" unless runtime
  device = runtime.fetch("supportedDeviceTypes").find { |entry| entry.fetch("name").include?("Ultra") }
  raise "No supported Watch Ultra device" unless device
  udid = command("xcrun", "simctl", "create", "OpenClaw runtime probe", device.fetch("identifier"), runtime.fetch("identifier")).strip
  raise "Invalid owned device UUID" unless udid.match?(/\A[\da-fA-F]{8}(?:-[\da-fA-F]{4}){3}-[\da-fA-F]{12}\z/)
  facts["udid"] = udid
  facts["runtime"] = runtime.fetch("identifier")
  puts "#{Time.now.utc.iso8601} Booting task-owned Watch #{udid}"
  $stdout.flush
  # The workflow owns the full lifecycle stream; this instance adds final inventories and crash summaries.
  trace = WatchBootTrace.new(udid, runtime.fetch("identifier"), File.expand_path("../build/watch-boot-trace.json", __dir__))
  facts["bootStartedAt"] = Time.now.utc.iso8601
  facts["bootOutput"] = command("xcrun", "simctl", "bootstatus", udid, "-b")
  # Hold across the observed ten-minute maintenance cycle, without app/build load.
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 720
  loop do
    devices = JSON.parse(command("xcrun", "simctl", "list", "devices", "--json")).fetch("devices").values.flatten
    state = devices.find { |entry| entry.fetch("udid") == udid }&.fetch("state") || "missing"
    facts.fetch("observations") << { "at" => Time.now.utc.iso8601, "state" => state }
    raise "Task-owned Watch became #{state}" unless state == "Booted"
    break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
    sleep(10)
  end
  facts["outcome"] = "survived-maintenance-window"
rescue StandardError => error
  facts["outcome"] = "failed"
  facts["error"] = error.message
  raise
ensure
  trace&.finish
  facts["finishedAt"] = Time.now.utc.iso8601
  begin
    facts["imagesAfter"] = JSON.parse(command("xcrun", "simctl", "runtime", "list", "-j"))
    facts["mountsAfter"] = command("/sbin/mount").lines.grep(/CoreSimulator|cryptex.*watchOS/)
  rescue StandardError => error
    facts["diagnosticError"] = error.message
  end
  FileUtils.mkdir_p(File.dirname(output))
  serialized = JSON.pretty_generate(facts).gsub(File.expand_path("~"), "<HOME>").gsub(%r{/Users/[^/\s]+}, "<HOME>")
  File.write(output, serialized)
  if udid&.match?(/\A[\da-fA-F]{8}(?:-[\da-fA-F]{4}){3}-[\da-fA-F]{12}\z/)
    Open3.capture3("xcrun", "simctl", "shutdown", udid)
    command("xcrun", "simctl", "delete", udid)
  end
end
