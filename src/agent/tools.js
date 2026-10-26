/**
 * The tool catalog.
 *
 * Names and argument shapes are Cursor's own, so the IDE renders the calls natively
 * and executes them itself — this server never touches the filesystem. Each entry
 * knows which Cursor tool type it maps to and how the model's arguments become an
 * exec request.
 *
 * Adding a tool means adding one entry here; the loop in turn.js picks it up.
 */

/** Cursor's tool types, as they appear in ToolCall. */
export const TOOL_TYPES = {
  Read: "readToolCall",
  Write: "editToolCall",
  Edit: "editToolCall",
  Delete: "deleteToolCall",
  Shell: "shellToolCall",
  Grep: "grepToolCall",
  Glob: "globToolCall",
  Task: "taskToolCall",
};

/** Exec request cases, from ExecServerMessage. */
export const EXEC_CASES = {
  Read: "readArgs",
  Write: "writeArgs",
  Edit: "writeArgs",
  Delete: "deleteArgs",
  Shell: "shellArgs",
  Grep: "grepArgs",
  Glob: "grepArgs",
  Task: "subagentArgs",
};

/** Subagent types Cursor defines, as the names its exec args take. */
export const SUBAGENT_TYPES = new Set([
  "explore",
  "debug",
  "bash",
  "shell",
  "browser_use",
  "computer_use",
  "media_review",
  "vm_setup_helper",
  "cursor_guide",
  "watch_video",
  "custom",
]);

/** Normalise line endings, as Cursor does before writing. */
function normaliseText(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Split a command line into the words Cursor's parser expects. */
function simpleCommands(command) {
  const first = command.trim().split(/\s+/).filter(Boolean)[0];
  return first ? [first] : [];
}

/**
 * One tool: what the model sees, and how a call becomes an exec request.
 *
 * `buildArgs` returns the ExecServerMessage payload. `render` turns the matching
 * ExecClientMessage result into the text the model reads back.
 */
export const TOOLS = [
  {
    name: "Read",
    description:
      "Read a file. Use this instead of cat. The path must be absolute. " +
      "Use offset and limit for large files.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path of the file to read." },
        offset: { type: "integer", description: "Line to start at (1-based)." },
        limit: { type: "integer", description: "How many lines to read." },
      },
    },
    startedArgs: (input) => ({ path: String(input.path ?? "") }),
    buildArgs: (input, toolCallId) => ({
      path: String(input.path ?? ""),
      tool_call_id: toolCallId,
      ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    }),
  },

  {
    name: "Write",
    description:
      "Write a file, replacing it if it exists. Prefer Edit for existing files.",
    parameters: {
      type: "object",
      required: ["path", "contents"],
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
        contents: { type: "string", description: "Full contents to write." },
      },
    },
    startedArgs: (input) => ({ path: String(input.path ?? "") }),
    buildArgs: (input, toolCallId) => {
      const text = normaliseText(input.contents ?? "");
      return {
        path: String(input.path ?? ""),
        file_text: text,
        stream_content: text,
        encoding_hint: "utf8",
        tool_call_id: toolCallId,
      };
    },
  },

  {
    name: "Edit",
    description:
      "Replace an exact string in a file. The old string must appear exactly once " +
      "unless replace_all is true.",
    parameters: {
      type: "object",
      required: ["path", "old_string", "new_string"],
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
        old_string: { type: "string", description: "Text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence." },
      },
    },
    // EditToolCall.args only carries the path and the new text, for the diff preview.
    startedArgs: (input) => ({
      path: String(input.path ?? ""),
      stream_content: normaliseText(input.new_string ?? ""),
    }),
    // The editor is told to read, then to write: there is no "replace" exec.
    buildArgs: (input, toolCallId) => ({
      path: String(input.path ?? ""),
      old_string: String(input.old_string ?? ""),
      new_string: normaliseText(input.new_string ?? ""),
      replace_all: input.replace_all === true,
      tool_call_id: toolCallId,
    }),
  },

  {
    name: "Delete",
    description: "Delete a file.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
      },
    },
    startedArgs: (input, toolCallId) => ({ path: String(input.path ?? ""), tool_call_id: toolCallId }),
    buildArgs: (input, toolCallId) => ({
      path: String(input.path ?? ""),
      tool_call_id: toolCallId,
    }),
  },

  {
    name: "Shell",
    description:
      "Run a shell command in the workspace. Use it for builds, tests and git.",
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Command line to run." },
        workingDirectory: { type: "string", description: "Directory to run in." },
        timeout: { type: "integer", description: "Timeout in milliseconds." },
        description: { type: "string", description: "Short description of the command." },
      },
    },
    buildArgs: (input, toolCallId) => {
      const command = String(input.command ?? "");
      const words = command.trim().split(/\s+/).filter(Boolean);
      return {
        command,
        working_directory: String(input.working_directory ?? input.workingDirectory ?? input.cwd ?? ""),
        timeout: Number(input.timeout ?? 30_000),
        tool_call_id: toolCallId,
        description: typeof input.description === "string" ? input.description : "",
        simple_commands: simpleCommands(command),
        parsing_result:
          words.length > 0
            ? {
                executable_commands: [
                  {
                    name: words[0],
                    full_text: command,
                    args: words.slice(1).map((value) => ({ type: "word", value })),
                  },
                ],
              }
            : undefined,
        timeout_behavior: 2,
        hard_timeout: 86_400_000,
      };
    },
  },

  {
    name: "Grep",
    description:
      "Search file contents with a regular expression. Use output_mode \"files_with_matches\" " +
      "to list paths, or \"content\" to see matching lines.",
    parameters: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "File or directory to search." },
        glob: { type: "string", description: "Only search files matching this glob." },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "What to return.",
        },
        "-i": { type: "boolean", description: "Case insensitive." },
        "-A": { type: "integer", description: "Lines after each match." },
        "-B": { type: "integer", description: "Lines before each match." },
        "-C": { type: "integer", description: "Lines around each match." },
        head_limit: { type: "integer", description: "Limit the number of results." },
      },
    },
    buildArgs: (input, toolCallId) => ({
      pattern: String(input.pattern ?? ""),
      ...(input.path ? { path: String(input.path) } : {}),
      ...(typeof input.glob === "string" ? { glob: input.glob } : {}),
      ...(typeof input.type === "string" ? { type: input.type } : {}),
      output_mode: typeof input.output_mode === "string" ? input.output_mode : "content",
      ...(typeof input["-i"] === "boolean" ? { case_insensitive: input["-i"] } : {}),
      ...(typeof input["-A"] === "number" ? { context_after: input["-A"] } : {}),
      ...(typeof input["-B"] === "number" ? { context_before: input["-B"] } : {}),
      ...(typeof input["-C"] === "number" ? { context: input["-C"] } : {}),
      ...(typeof input.multiline === "boolean" ? { multiline: input.multiline } : {}),
      ...(typeof input.head_limit === "number" ? { head_limit: input.head_limit } : {}),
      ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
      tool_call_id: toolCallId,
    }),
  },

  {
    name: "Glob",
    description:
      "Find files by glob pattern, sorted by modification time. " +
      "Patterns without a leading **/ are matched recursively.",
    parameters: {
      type: "object",
      required: ["glob_pattern"],
      properties: {
        glob_pattern: { type: "string", description: "Pattern, for example *.ts." },
        target_directory: { type: "string", description: "Directory to search in." },
      },
    },
    startedArgs: (input) => ({
      glob_pattern: String(input.glob_pattern ?? input.pattern ?? ""),
      target_directory: String(input.target_directory ?? ""),
    }),
    buildArgs: (input, toolCallId) => {
      const pattern = String(input.glob_pattern ?? input.pattern ?? "");
      return {
        pattern: pattern.startsWith("**/") ? pattern : `**/${pattern}`,
        ...(input.target_directory ? { path: String(input.target_directory) } : {}),
        output_mode: "files_with_matches",
        tool_call_id: toolCallId,
      };
    },
  },

  {
    name: "Task",
    description:
      "Launch a subagent to handle a multi-step task autonomously. " +
      "Use subagent_type \"explore\" for broad codebase questions; for a narrow " +
      "lookup, use Grep or Read directly. Several Task calls in one turn run " +
      "concurrently, so split independent areas of the codebase across them.",
    parameters: {
      type: "object",
      required: ["description", "prompt"],
      properties: {
        description: { type: "string", description: "Short description of the task." },
        prompt: { type: "string", description: "What the subagent should do." },
        subagent_type: {
          type: "string",
          description: "explore, debug, bash, browser_use, media_review, or custom.",
        },
        resume: { type: "string", description: "Agent id to resume, or \"self\"." },
        run_in_background: {
          type: "boolean",
          description: "Return immediately and let the subagent run in the background.",
        },
      },
    },
    // TaskArgs.subagent_type is a message with one empty variant per type.
    startedArgs: (input) => {
      const type = subagentTypeName(input);
      return {
        description: String(input.description ?? ""),
        prompt: String(input.prompt ?? ""),
        ...(type ? { subagent_type: { [type]: {} } } : {}),
        ...(typeof input.resume === "string" ? { resume: input.resume } : {}),
      };
    },
    // SubagentArgs.subagent_type is the plain name, and it wants a model id.
    buildArgs: (input, toolCallId, context = {}) => ({
      tool_call_id: toolCallId,
      subagent_type: subagentTypeName(input) || "explore",
      model_id: context.modelId ?? "",
      prompt: String(input.prompt ?? input.description ?? ""),
      readonly: input.readonly === true,
      ...(typeof input.run_in_background === "boolean"
        ? { run_in_background: input.run_in_background }
        : {}),
      ...(context.conversationId ? { parent_conversation_id: context.conversationId } : {}),
    }),
  },
];

/** The subagent type, defaulted and checked against the types Cursor defines. */
function subagentTypeName(input) {
  const raw = input.subagent_type ?? input.subagentType ?? "explore";
  const name = String(raw).trim().toLowerCase().replace(/-/g, "_");
  return SUBAGENT_TYPES.has(name) ? name : "explore";
}

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Look a tool up by the name the model used. */
export function findTool(name) {
  if (byName.has(name)) return byName.get(name);
  // Cursor's Anthropic profile calls Read "ReadFile" and Grep "rg".
  const alias = { ReadFile: "Read", rg: "Grep", ApplyPatch: "Edit", Subagent: "Task" }[name];
  return alias ? byName.get(alias) : null;
}

/** The tool list handed to the provider. */
export function providerTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** Join the text parts of a Grep content match. */
function grepContentText(success) {
  const lines = [];
  for (const match of success?.matches ?? []) {
    const file = match.file ?? "";
    for (const item of match.matches ?? []) {
      const line = item.line_number ? `${item.line_number}:` : "";
      lines.push(`${file}:${line}${item.content ?? ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Convert an exec result into the result type the UI expects.
 *
 * The two are not the same message: the editor reports what it did (WriteResult),
 * while the interaction update describes the call (EditToolCall.result). Passing one
 * where the other belongs silently loses fields, so each tool names its mapping.
 */
export function toToolResult(toolName, result) {
  if (!result) return null;
  const outcome = Object.keys(result)[0];
  const value = result[outcome] ?? {};

  switch (toolName) {
    case "Write":
    case "Edit":
      if (outcome !== "success") return result;
      return {
        success: {
          path: value.path ?? "",
          lines_added: value.lines_created ?? 0,
          lines_removed: 0,
          diff_string: "",
          after_full_file_content: value.file_content_after_write ?? "",
          message: "",
        },
      };

    case "Task": {
      // The editor reports a SubagentResult; the tool call declares a TaskResult.
      // Only the shared fields carry over, and the final message is read from the
      // exec result directly.
      if (outcome !== "success") return result;
      return {
        success: {
          agent_id: value.agent_id ?? "",
          is_background: (value.background_reason ?? 0) !== 0,
          duration_ms: 0,
          result_suffix: "",
          transcript_path: value.transcript_path ?? "",
        },
      };
    }

    case "Glob": {
      if (outcome !== "success") return result;
      const files = value.workspace_results?.files?.files ?? value.files ?? [];
      return {
        success: {
          pattern: value.pattern ?? "",
          path: value.path ?? "",
          files,
          total_files: files.length,
        },
      };
    }

    default:
      return result;
  }
}

/**
 * Turn an exec result into the text the model sees.
 *
 * Every result variant is handled: a tool that reports a permission error must not
 * look like a success to the model, or it will retry the same call.
 */
export function renderResult(toolName, result) {
  if (!result) return "No result was returned by the editor.";

  const outcome = Object.keys(result)[0];
  const value = result[outcome];

  switch (outcome) {
    case "success":
      return renderSuccess(toolName, value);
    case "error":
      return `Error: ${value?.message ?? value?.error ?? "the tool failed"}`;
    case "fileNotFound":
    case "file_not_found":
      return `Error: file not found: ${value?.path ?? ""}`;
    case "permissionDenied":
    case "permission_denied":
      return `Error: permission denied: ${value?.path ?? ""}`;
    case "readPermissionDenied":
      return `Error: permission denied reading ${value?.path ?? ""}`;
    case "writePermissionDenied":
      return `Error: permission denied writing ${value?.path ?? ""}`;
    case "rejected":
      return "The user rejected this tool call. Do not retry it; ask how to proceed.";
    case "timeout":
      return "Error: the command timed out.";
    case "spawnError":
      return `Error: could not start the command: ${value?.message ?? ""}`;
    case "noSpace":
      return "Error: no space left on device.";
    default:
      return `Result: ${JSON.stringify(result).slice(0, 2000)}`;
  }
}

function renderSuccess(toolName, value) {
  switch (toolName) {
    case "Read":
      return value?.content || (value?.is_empty ? "(empty file)" : "(no content)");

    case "Write":
      return `Wrote ${value?.path ?? "the file"} (${value?.lines_created ?? 0} lines).`;

    case "Edit":
      return value?.message || `Edited ${value?.path ?? "the file"}.`;

    case "Delete":
      return `Deleted ${value?.deleted_file ?? value?.path ?? "the file"}.`;

    case "Shell": {
      const parts = [];
      if (value?.stdout) parts.push(value.stdout);
      if (value?.stderr) parts.push(`[stderr]\n${value.stderr}`);
      const code = value?.exit_code ?? 0;
      if (code !== 0) parts.push(`[exit code ${code}]`);
      return parts.join("\n") || "(no output)";
    }

    case "Grep": {
      if (value?.output_mode === "files_with_matches") {
        const files = value.workspace_results?.files ?? value.files ?? [];
        return files.length > 0 ? files.join("\n") : "No files matched.";
      }
      const text = grepContentText(value.workspace_results ?? value);
      return text || "No matches.";
    }

    case "Glob": {
      const files = value?.files ?? [];
      return files.length > 0 ? files.join("\n") : "No files matched.";
    }

    case "Task": {
      // The subagent's answer is what the model needs; the agent id is bookkeeping.
      const message = value?.final_message ?? value?.finalMessage ?? "";
      const count = value?.tool_call_count ?? 0;
      if (message.length === 0) {
        return `The subagent finished without a message (${count} tool calls).`;
      }
      return count > 0 ? `${message}\n\n[subagent used ${count} tool calls]` : message;
    }

    default:
      return JSON.stringify(value ?? {}).slice(0, 2000);
  }
}
