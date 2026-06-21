import { tool } from "@opencode-ai/plugin";

const callDiffuse = async (path: string, body: unknown) => {
  const url = process.env.DIFFUSE_REVIEW_BRIDGE_URL;
  const token = process.env.DIFFUSE_REVIEW_BRIDGE_TOKEN;
  if (!url || !token) throw new Error("Diffuse review bridge is not configured");
  const response = await fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || "Diffuse review tool failed: " + response.status);
  return text;
};

export const add_comment = tool({
  description: "Add a validated Diffuse review comment anchored to a changed file line.",
  args: {
    filePath: tool.schema.string().describe("Changed file path to comment on"),
    side: tool.schema.enum(["old", "new"]).describe("Diff side"),
    startLine: tool.schema.number().describe("1-based start line"),
    endLine: tool.schema.number().describe("1-based end line"),
    body: tool.schema.string().describe("Actionable review comment"),
    severity: tool.schema.enum(["info", "low", "medium", "high", "critical"]).optional(),
    category: tool.schema.enum(["bug", "security", "performance", "maintainability", "test", "style", "question"]).optional(),
    confidence: tool.schema.enum(["low", "medium", "high"]).optional(),
    selectedText: tool.schema.string().optional(),
  },
  async execute(args) {
    return callDiffuse("/add-comment", args);
  },
});

export const set_progress = tool({
  description: "Update Diffuse review progress with a short user-visible status message.",
  args: {
    status: tool.schema.enum(["idle", "planning", "running", "paused", "completed", "failed", "cancelled"]),
    message: tool.schema.string().optional(),
    totalFiles: tool.schema.number().optional(),
    reviewedFiles: tool.schema.number().optional(),
    activeFiles: tool.schema.array(tool.schema.string()).optional(),
    pendingFiles: tool.schema.array(tool.schema.string()).optional(),
    completedFiles: tool.schema.array(tool.schema.string()).optional(),
  },
  async execute(args) {
    return callDiffuse("/set-progress", { ...args, lastActivityAt: new Date().toISOString() });
  },
});

export const set_agent_state = tool({
  description: "Update Diffuse review agent state with current file and a concise user-visible activity summary. Do not include hidden chain-of-thought.",
  args: {
    status: tool.schema.enum(["starting", "running", "idle", "completed", "failed", "cancelled"]),
    currentPhase: tool.schema.string().optional(),
    currentFile: tool.schema.string().optional(),
    lastThoughtSummary: tool.schema.string().optional(),
  },
  async execute(args) {
    return callDiffuse("/set-agent-state", { ...args, updatedAt: new Date().toISOString() });
  },
});

export const get_changed_files = tool({
  description: "Get the changed files assigned to this Diffuse review run.",
  args: {},
  async execute() {
    return callDiffuse("/changed-files", {});
  },
});

export const get_diff = tool({
  description: "Get the full diff render model for a changed file.",
  args: { fileId: tool.schema.string().describe("Changed file id/path") },
  async execute(args) {
    return callDiffuse("/diff", args);
  },
});
