require "open3"
require "fileutils"
require "json"
require "time"

# Temporary instrumentation, confined to the diagnostic branch.
module InventoryProbe
  @observers = []
  @sampled = false
  @record_mutex = Mutex.new

  def self.capture(*arguments)
    directory = ENV["OPENCLAW_INVENTORY_PROBE_DIRECTORY"]
    return Open3.capture3(*arguments) unless directory
    phase_path = ENV["OPENCLAW_IOS_RESOURCE_PHASE_PATH"]
    phase = File.read(phase_path).strip if phase_path && File.file?(phase_path)
    return Open3.capture3(*arguments) unless phase.to_s.match?(/\Ascreenshot-(iphone|ipad|watch)-boot\z/)

    begin
      FileUtils.mkdir_p(directory)
    rescue SystemCallError
      return Open3.capture3(*arguments)
    end
    started_at = Time.now.utc.iso8601(3)
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    Open3.popen3(*arguments) do |stdin, stdout, stderr, waiter|
      spawned = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      stdin.close
      output = Thread.new { [stdout.read, Process.clock_gettime(Process::CLOCK_MONOTONIC)] }
      errors = Thread.new { [stderr.read, Process.clock_gettime(Process::CLOCK_MONOTONIC)] }
      exited = Thread.new { [waiter.value, Process.clock_gettime(Process::CLOCK_MONOTONIC)] }
      @observers << Thread.new do
        if exited.join(10).nil? && !@sampled
          @sampled = true
          sample(directory, phase, waiter.pid)
        end
      rescue StandardError => error
        record(directory, { type: "probe", phase: phase, outcome: "unavailable", errorClass: error.class.name })
      end
      status, child_exited = exited.value
      out, stdout_eof = output.value
      err, stderr_eof = errors.value
      record(directory, {
        type: "inventory", phase: phase, startedAt: started_at, pid: waiter.pid,
        spawnReturnedSeconds: (spawned - started).round(3),
        childExitObservedSeconds: (child_exited - started).round(3),
        stdoutEOFObservedSeconds: (stdout_eof - started).round(3),
        stderrEOFObservedSeconds: (stderr_eof - started).round(3),
        returnObservedSeconds: (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(3),
        exitStatus: status.exitstatus, signal: status.termsig
      })
      [out, err, status]
    end
  end

  def self.sample(directory, phase, pid)
    raw_path = File.join(directory, "simctl.raw.txt")
    started_at = Time.now.utc.iso8601(3)
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    sampler = Process.spawn("/usr/bin/sample", pid.to_s, "1", "20", "-mayDie", "-file", raw_path,
      out: File::NULL, err: File::NULL, pgroup: true)
    finished = Process.detach(sampler)
    timed_out = finished.join(5).nil?
    stop_sampler(sampler) if timed_out
    status = finished.value
    settled = true
    if File.file?(raw_path)
      raw = File.read(raw_path)
      graph = raw.split("Call graph:\n", 2).last if raw.include?("Call graph:\n")
      graph = graph&.split("Total number in stack", 2)&.first
      if graph
        sanitized = graph.lines.reject { |line| line.match?(%r{/(Users|Volumes|private|Applications|Library|System|usr|opt|var|tmp)/}) }
          .join.gsub(/0x[0-9a-fA-F]+/, "<address>")
        File.write(File.join(directory, "simctl.stacks.txt"), sanitized)
      end
    end
    record(directory, {
      type: "sample", phase: phase, targetPid: pid, startedAt: started_at,
      outcome: timed_out ? "timeout" : (status.success? ? "succeeded" : "unavailable"),
      durationSeconds: (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(3)
    })
  rescue StandardError => error
    record(directory, { type: "sample", phase: phase, outcome: "unavailable", errorClass: error.class.name })
  ensure
    if sampler && !settled
      stop_sampler(sampler)
      finished ? finished.value : Process.waitpid(sampler)
    end
    FileUtils.rm_f(raw_path) if raw_path
  end

  def self.stop_sampler(pid)
    Process.kill("KILL", -pid)
  rescue Errno::ESRCH
    nil
  end

  def self.record(directory, event)
    @record_mutex.synchronize do
      File.open(File.join(directory, "observations.jsonl"), "a") { |file| file.write(JSON.generate(event) + "\n") }
    end
  rescue SystemCallError
    nil
  end

  def self.finish
    @observers.each(&:join)
  end
end

at_exit { InventoryProbe.finish }
