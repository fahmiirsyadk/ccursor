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
};

/** Exec request cases, from ExecServerMessage. */
export const EXEC_CASES = {
  Read: "readArgs",
  Write: "writeArgs",
  Edit: "writeArgs",
  Delete: "deleteArgs",
  Shell: "shellStreamArgs",
  Grep: "grepArgs",
  Glob: "grepArgs",
};

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
    buildArgs: (input, toolCallId) => ({
      path: String(input.path ?? ""),
      toolCallId,
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
    buildArgs: (input, toolCallId) => {
      const text = normaliseText(input.contents ?? "");
      return {
        path: String(input.path ?? ""),
        fileText: text,
        streamContent: text,
        encodingHint: "utf8",
        toolCallId,
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
    buildArgs: (input, toolCallId) => ({
      path: String(input.path ?? ""),
      oldString: String(input.old_string ?? ""),
      newString: String(input.new_string ?? ""),
      replaceAll: input.replace_all === true,
      toolCallId,
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
    buildArgs: (input, toolCallId) => ({
      path: String(input.path ?? ""),
      toolCallId,
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
        workingDirectory: String(input.workingDirectory ?? input.cwd ?? ""),
        timeout: Number(input.timeout ?? 30_000),
        toolCallId,
        description: typeof input.description === "string" ? input.description : "",
        simpleCommands: simpleCommands(command),
        parsingResult:
          words.length > 0
            ? {
                executableCommands: [
                  {
                    name: words[0],
                    fullText: command,
                    args: words.slice(1).map((value) => ({ type: "word", value })),
                  },
                ],
              }
            : undefined,
        timeoutBehavior: 2,
        hardTimeout: 86_400_000,
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
      outputMode: typeof input.output_mode === "string" ? input.output_mode : "content",
      ...(typeof input["-i"] === "boolean" ? { caseInsensitive: input["-i"] } : {}),
      ...(typeof input["-A"] === "number" ? { contextAfter: input["-A"] } : {}),
      ...(typeof input["-B"] === "number" ? { contextBefore: input["-B"] } : {}),
      ...(typeof input["-C"] === "number" ? { context: input["-C"] } : {}),
      ...(typeof input.multiline === "boolean" ? { multiline: input.multiline } : {}),
      ...(typeof input.head_limit === "number" ? { headLimit: input.head_limit } : {}),
      ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
      toolCallId,
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
    buildArgs: (input, toolCallId) => {
      const pattern = String(input.glob_pattern ?? input.pattern ?? "");
      return {
        pattern: pattern.startsWith("**/") ? pattern : `**/${pattern}`,
        ...(input.target_directory ? { path: String(input.target_directory) } : {}),
        outputMode: "files_with_matches",
        toolCallId,
      };
    },
  },
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Look a tool up by the name the model used. */
export function findTool(name) {
  if (byName.has(name)) return byName.get(name);
  // Cursor's Anthropic profile calls Read "ReadFile" and Grep "rg".
  const alias = { ReadFile: "Read", rg: "Grep", ApplyPatch: "Edit" }[name];
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

    default:
      return JSON.stringify(value ?? {}).slice(0, 2000);
  }
}
