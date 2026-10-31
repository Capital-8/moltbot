require "json"
require "open3"

module WatchRuntimeAdmission
  def self.wait!
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 120
    previous = nil
    removed = []
    loop do
      output, error, status = Open3.capture3("xcrun", "simctl", "runtime", "list", "-j")
      raise "Cannot inspect Watch runtime cleanup: #{error.strip}" unless status.success?
      images = JSON.parse(output).values.select { |image| image["platformIdentifier"] == "com.apple.platform.watchsimulator" }
      return if images.empty?

      mounts, error, status = Open3.capture3("/sbin/mount")
      raise "Cannot inspect Watch runtime mounts: #{error.strip}" unless status.success?
      facts = images.map do |image|
        path = image["mountPath"]
        mounted = path && mounts.lines.any? { |line| line.include?(" on #{path} (") }
        { "runtime" => image["runtimeIdentifier"], "state" => image["state"], "mounted" => !!mounted }
      end
      ready = facts.all? { |image| image["state"] == "Ready" && image["mounted"] } &&
        facts.group_by { |image| image["runtime"] }.values.all? { |entries| entries.length == 1 }
      return if ready

      if facts != previous
        puts "Waiting for Watch runtime cleanup: #{JSON.generate(facts)}"
        $stdout.flush
        previous = facts
      end
      # CoreSimulator can retain unmounted unusable registrations after replacing
      # their image. Retire those registrations without purging the shared asset.
      stale = images.zip(facts).select do |image, fact|
        fact["state"] == "Unusable" && !fact["mounted"] && !removed.include?(image.fetch("identifier")) &&
          facts.count { |entry| entry["runtime"] == fact["runtime"] && entry["state"] == "Ready" && entry["mounted"] } == 1
      end
      unless stale.empty?
        stale.each do |image, _|
          identifier = image.fetch("identifier")
          puts "Retiring unmounted unusable Watch registration #{identifier}"
          $stdout.flush
          _, error, status = Open3.capture3("xcrun", "simctl", "runtime", "delete", identifier, "--keep-asset")
          raise "Cannot retire stale Watch registration: #{error.strip}" unless status.success?
          removed << identifier
        end
        _, error, status = Open3.capture3("xcrun", "simctl", "runtime", "scan-and-mount")
        raise "Cannot remount Watch runtime after stale registration cleanup: #{error.strip}" unless status.success?
      end
      raise "Watch runtime cleanup did not settle before simulator admission" if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
      sleep(2)
    end
  end
end
