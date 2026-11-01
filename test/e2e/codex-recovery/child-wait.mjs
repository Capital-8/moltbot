import assert from "node:assert/strict";

// The synthetic model requests real native spawn/wait operations. The child result must
// be present in the parent's model input before the parent is allowed to return its answer.
export function childWaitStep(input, restarted, recovering) {
  if (
    input.some(
      (item) =>
        item.type === "agent_message" &&
        item.recipient === "/root/child" &&
        JSON.stringify(item.content).includes("SCOPE_CHILD_TASK"),
    )
  ) {
    return "child-model";
  }
  if (!restarted) {
    const spawnResult = input.find(
      (item) => item.type === "function_call_output" && item.call_id === "scope_spawn",
    );
    if (!spawnResult) {
      return "parent-spawn";
    }
    assert.ok(
      String(spawnResult.output).includes("task_name"),
      "native must have spawned the original child",
    );
    return "parent-wait";
  }
  if (recovering) {
    assert.ok(
      input.some(
        (item) =>
          item.type === "agent_message" &&
          item.author === "/root/child" &&
          JSON.stringify(item.content).includes("SCOPE_CHILD_DONE"),
      ),
      "parent must receive the original child's result",
    );
    return "parent-collected-child";
  }
}

export function sendChildWaitTool(res, step, requestNumber) {
  const spawn = step === "parent-spawn";
  const callId = spawn ? "scope_spawn" : "scope_wait";
  const item = {
    type: "function_call",
    namespace: "collaboration",
    name: spawn ? "spawn_agent" : "wait_agent",
    arguments: JSON.stringify(
      spawn
        ? {
            task_name: "child",
            fork_turns: "none",
            message: "SCOPE_CHILD_TASK: return SCOPE_CHILD_DONE.",
          }
        : { timeout_ms: 120000 },
    ),
    call_id: callId,
    id: "fc_" + callId,
    status: "completed",
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + requestNumber,
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      },
    },
  ];
  res
    .writeHead(200, { "content-type": "text/event-stream" })
    .end(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""));
}
