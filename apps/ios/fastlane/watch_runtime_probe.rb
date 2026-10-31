require "json"
require "open3"
require "fileutils"
require "time"
require "tempfile"
require "tmpdir"
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
package_root = nil
begin
  facts["runtimeHelp"], = Open3.capture3("xcrun", "simctl", "runtime", "help")
  facts["imagesBefore"] = JSON.parse(command("xcrun", "simctl", "runtime", "list", "-j"))
  runtimes = JSON.parse(command("xcrun", "simctl", "list", "runtimes", "--json")).fetch("runtimes")
  runtime = runtimes.select { |entry| entry["isAvailable"] && entry.fetch("identifier").include?(".watchOS-") }
    .max_by { |entry| Gem::Version.new(entry.fetch("version")) }
  raise "No available Watch runtime" unless runtime
  WatchRuntimeAdmission.wait!
  package_root = Dir.mktmpdir("openclaw-watch-arm64-", ENV.fetch("RUNNER_TEMP"))
  facts["downloadOutput"] = command("xcodebuild", "-downloadPlatform", "watchOS", "-buildVersion", runtime.fetch("version"),
    "-architectureVariant", "arm64", "-exportPath", package_root)
  packages = Dir[File.join(package_root, "**", "*.dmg")]
  raise "Expected one exported arm64 Watch runtime package, found #{packages.length}" unless packages.one?
  facts["packageName"] = File.basename(packages.first)
  facts["packageBytes"] = File.size(packages.first)
  WatchRuntimeAdmission.wait!
  images = JSON.parse(command("xcrun", "simctl", "runtime", "list", "-j")).values
  image = images.find { |entry| entry["runtimeIdentifier"] == runtime.fetch("identifier") && entry["state"] == "Ready" }
  raise "No Ready Watch image to replace" unless image
  facts["retiredImage"] = image.fetch("identifier")
  retired_path = image.fetch("path")
  facts["deletions"] = []
  2.times do |attempt|
    stdout, stderr, status = Open3.capture3("xcrun", "simctl", "runtime", "delete", image.fetch("identifier"))
    facts.fetch("deletions") << { "image" => image.fetch("identifier"), "stdout" => stdout, "stderr" => stderr, "status" => status.exitstatus }
    break if status.success?
    detail = stdout + stderr
    unless attempt.zero? && detail.include?("domain=com.apple.CoreSimulator.simdiskimaged.SimDiskImageError, code=30)") &&
      detail.include?("Removed the runtime, but did not reclaim its MobileAsset")
      raise "Watch runtime deletion failed: #{detail.strip}"
    end
    # Follow the existing repair owner's single recovery for incomplete asset reclamation.
    facts["scanOutput"] = command("xcrun", "simctl", "runtime", "scan-and-mount")
    WatchRuntimeAdmission.wait!
    images = JSON.parse(command("xcrun", "simctl", "runtime", "list", "-j")).values
      .select { |entry| entry["runtimeIdentifier"] == runtime.fetch("identifier") && entry["state"] != "Deleting" }
    raise "Expected one Watch image after scan, found #{images.length}" unless images.one?
    image = images.first
  end
  facts["assetRetired"] = !File.exist?(retired_path)
  raise "Broken Watch asset remains after supported runtime deletion" unless facts.fetch("assetRetired")
  facts["importOutput"] = command("xcodebuild", "-importPlatform", packages.first)
  facts["imagesImported"] = JSON.parse(command("xcrun", "simctl", "runtime", "list", "-j"))
  WatchRuntimeAdmission.wait!
  facts["admittedAt"] = Time.now.utc.iso8601
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
  FileUtils.remove_entry(package_root) if package_root && File.directory?(package_root)
end
