"use strict";

const childProcess = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const EXTENSION_ID = "codexLineCleaner";
const OUTPUT_NAME = "Codex Line Cleaner";
const MAX_PROCESS_OUTPUT_CHARS = 20000;

const state = {
  enabled: false,
  running: false,
  pending: new Map(),
  idleTimer: undefined,
  lastEditAt: 0,
  nextId: 1,
  currentProcess: undefined,
  statusBar: undefined,
  output: undefined,
  context: undefined
};

function activate(context) {
  state.context = context;
  state.output = vscode.window.createOutputChannel(OUTPUT_NAME);
  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  state.statusBar.command = `${EXTENSION_ID}.toggle`;
  state.statusBar.tooltip = "Toggle Codex line cleaning";
  state.statusBar.show();

  context.subscriptions.push(
    state.output,
    state.statusBar,
    vscode.commands.registerCommand(`${EXTENSION_ID}.toggle`, toggle),
    vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument)
  );

  updateStatusBar();
}

function deactivate() {
  clearIdleTimer();
  stopCurrentCodexProcess();
}

function toggle() {
  state.enabled = !state.enabled;

  if (!state.enabled) {
    state.pending.clear();
    clearIdleTimer();
    stopCurrentCodexProcess();
    state.output.appendLine("Disabled. Cleared pending lines and stopped any active Codex call.");
  } else {
    state.output.appendLine("Enabled.");
  }

  updateStatusBar();
}

function onDidChangeTextDocument(event) {
  if (!state.enabled || event.contentChanges.length === 0) {
    return;
  }

  state.lastEditAt = Date.now();

  for (const change of event.contentChanges) {
    if (countNewlineSequences(change.text) !== 1) {
      continue;
    }

    captureCompletedLine(event.document, change.range.start.line);
  }

  if (state.pending.size > 0) {
    scheduleFlush();
  }
}

function captureCompletedLine(document, lineNumber) {
  if (lineNumber < 0 || lineNumber >= document.lineCount) {
    return;
  }

  const originalText = document.lineAt(lineNumber).text;
  if (originalText.trim().length === 0) {
    return;
  }

  const uri = document.uri.toString();
  const key = `${uri}:${lineNumber}`;
  const id = `line-${state.nextId++}`;

  state.pending.set(key, {
    id,
    key,
    uri,
    filePath: document.uri.fsPath || uri,
    lineNumber,
    languageId: document.languageId,
    originalText,
    context: getNearbyContext(document, lineNumber)
  });

  updateStatusBar();
}

function getNearbyContext(document, lineNumber) {
  const start = Math.max(0, lineNumber - 2);
  const end = Math.min(document.lineCount - 1, lineNumber + 2);
  const lines = [];

  for (let i = start; i <= end; i += 1) {
    lines.push({
      lineNumber: i + 1,
      isPendingLine: i === lineNumber,
      text: document.lineAt(i).text
    });
  }

  return lines;
}

function scheduleFlush() {
  if (!state.enabled) {
    return;
  }

  clearIdleTimer();

  const elapsed = Date.now() - state.lastEditAt;
  const delay = Math.max(0, getIdleDelayMs() - elapsed);

  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    flushPendingLines().catch((error) => {
      state.output.appendLine(`Unexpected cleaner error: ${formatError(error)}`);
      updateStatusBar("error");
    });
  }, delay);
}

async function flushPendingLines() {
  if (!state.enabled || state.running || state.pending.size === 0) {
    return;
  }

  const batch = Array.from(state.pending.values());
  for (const item of batch) {
    state.pending.delete(item.key);
  }

  state.running = true;
  updateStatusBar("running");
  state.output.appendLine(`Sending ${batch.length} completed line(s) to Codex.`);

  try {
    const parsed = await runCodex(batch);
    if (!state.enabled) {
      return;
    }

    const results = validateBatchResponse(parsed, batch);
    const applied = await applyValidatedResults(results, batch);
    state.output.appendLine(`Applied ${applied} replacement(s).`);
  } catch (error) {
    state.output.appendLine(`Rejected Codex batch: ${formatError(error)}`);
    updateStatusBar("error");
  } finally {
    state.running = false;
    updateStatusBar();

    if (state.enabled && state.pending.size > 0) {
      scheduleFlush();
    }
  }
}

async function runCodex(batch) {
  const config = getConfig();
  const codexPath = config.get("codexPath", "codex");
  const schemaPath = state.context.asAbsolutePath("line-fix.schema.json");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-line-cleaner-"));
  const outputFile = path.join(tempDir, "result.json");
  const args = buildCodexArgs(config, schemaPath, outputFile);
  const prompt = buildPrompt(batch, config.get("additionalInstructions", ""));

  try {
    const raw = await spawnCodex(codexPath, args, prompt, getTimeoutMs());
    const output = await fs.readFile(outputFile, "utf8").catch(() => raw);
    return JSON.parse(output);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildCodexArgs(config, schemaPath, outputFile) {
  const args = [
    "--ask-for-approval",
    "never",
    "exec"
  ];

  const model = config.get("model", "gpt-5.4-mini").trim();
  if (model.length > 0) {
    args.push("--model", model);
  }

  const reasoningEffort = config.get("reasoningEffort", "low");
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  }

  args.push(
    "--ephemeral",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "-o",
    outputFile,
    "-"
  );

  return args;
}

function spawnCodex(command, args, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: getWorkspaceCwd(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    state.currentProcess = child;

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString());
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString());
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (state.currentProcess === child) {
        state.currentProcess = undefined;
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (state.currentProcess === child) {
        state.currentProcess = undefined;
      }

      if (timedOut) {
        reject(new Error(`Codex timed out after ${timeoutMs}ms.`));
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Codex exited with code ${code}.`));
        return;
      }

      resolve(stdout);
    });

    child.stdin.end(prompt, "utf8");
  });
}

function buildPrompt(batch, additionalInstructions) {
  const payload = {
    lines: batch.map((item) => ({
      id: item.id,
      uri: item.uri,
      filePath: item.filePath,
      languageId: item.languageId,
      lineNumber: item.lineNumber + 1,
      originalText: item.originalText,
      nearbyContext: item.context
    }))
  };

  const symbolHint = [
    0x2208,
    0x2200,
    0x2264,
    0x2265,
    0x2115,
    0x00b7,
    0x2212
  ].map((codePoint) => String.fromCodePoint(codePoint)).join(", ");

  const parts = [
    "Return only JSON matching the provided schema.",
    "Clean the pending lines in the batch.",
    "",
    "Rules:",
    "- Preserve meaning and syntax.",
    "- Treat each pending line independently.",
    "- Return one result for every input id.",
    "- If a line is code, config, or identifier-heavy, leave it unchanged unless the fix is clearly safe.",
    "- For prose or math notes, fix spelling, grammar, spacing, and notation.",
    `- Prefer these math symbols where appropriate: ${symbolHint}.`,
    "- Do not solve exercises.",
    "- Do not add explanations.",
    "- Do not add code fences.",
    "- Do not produce multiline replacements.",
    "- For unchanged lines, set changed to false and replacement to the exact original text.",
    "",
    "Batch JSON:",
    JSON.stringify(payload, null, 2)
  ];

  const trimmedExtra = additionalInstructions.trim();
  if (trimmedExtra.length > 0) {
    parts.push("", "Additional user instructions:", trimmedExtra);
  }

  return parts.join("\n");
}

function validateBatchResponse(parsed, batch) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.results)) {
    throw new Error("Codex response did not contain a results array.");
  }

  const batchById = new Map(batch.map((item) => [item.id, item]));
  const validated = [];

  for (const result of parsed.results) {
    if (!result || typeof result !== "object") {
      state.output.appendLine("Skipped malformed result.");
      continue;
    }

    const item = batchById.get(result.id);
    if (!item) {
      state.output.appendLine(`Skipped result with unknown id: ${String(result.id)}`);
      continue;
    }

    if (typeof result.changed !== "boolean" || typeof result.replacement !== "string") {
      state.output.appendLine(`Skipped result with invalid fields: ${item.id}`);
      continue;
    }

    if (!result.changed || result.replacement === item.originalText) {
      continue;
    }

    if (result.replacement.trim().length === 0) {
      state.output.appendLine(`Skipped blank replacement: ${item.id}`);
      continue;
    }

    if (countNewlineSequences(result.replacement) > 0) {
      state.output.appendLine(`Skipped multiline replacement: ${item.id}`);
      continue;
    }

    validated.push({ item, replacement: result.replacement });
  }

  return validated;
}

async function applyValidatedResults(results) {
  let applied = 0;

  for (const result of results) {
    const document = findOpenDocument(result.item.uri);
    if (!document) {
      state.output.appendLine(`Skipped closed document: ${result.item.uri}`);
      continue;
    }

    if (result.item.lineNumber < 0 || result.item.lineNumber >= document.lineCount) {
      state.output.appendLine(`Skipped missing line: ${result.item.id}`);
      continue;
    }

    const line = document.lineAt(result.item.lineNumber);
    if (line.text !== result.item.originalText) {
      state.output.appendLine(`Skipped changed line: ${result.item.id}`);
      continue;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, line.range, result.replacement);

    if (await vscode.workspace.applyEdit(edit)) {
      applied += 1;
    } else {
      state.output.appendLine(`VS Code rejected edit: ${result.item.id}`);
    }
  }

  return applied;
}

function findOpenDocument(uriString) {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uriString);
}

function countNewlineSequences(text) {
  return (text.match(/\r\n|\r|\n/g) || []).length;
}

function appendLimited(current, next) {
  const joined = current + next;
  if (joined.length <= MAX_PROCESS_OUTPUT_CHARS) {
    return joined;
  }

  return joined.slice(joined.length - MAX_PROCESS_OUTPUT_CHARS);
}

function getConfig() {
  return vscode.workspace.getConfiguration(EXTENSION_ID);
}

function getIdleDelayMs() {
  return Math.max(1000, getConfig().get("idleDelayMs", 5000));
}

function getTimeoutMs() {
  return Math.max(5000, getConfig().get("timeoutMs", 60000));
}

function getWorkspaceCwd() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (folder && folder.uri.scheme === "file") {
    return folder.uri.fsPath;
  }

  return os.homedir();
}

function clearIdleTimer() {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
}

function stopCurrentCodexProcess() {
  if (state.currentProcess) {
    state.currentProcess.kill();
    state.currentProcess = undefined;
  }
}

function updateStatusBar(mode) {
  if (!state.statusBar) {
    return;
  }

  if (!state.enabled) {
    state.statusBar.text = "$(circle-slash) Codex Clean";
    state.statusBar.tooltip = "Codex line cleaning is off";
    return;
  }

  if (mode === "running" || state.running) {
    state.statusBar.text = "$(sync~spin) Codex Clean";
    state.statusBar.tooltip = "Codex is checking completed lines";
    return;
  }

  if (mode === "error") {
    state.statusBar.text = "$(warning) Codex Clean";
    state.statusBar.tooltip = "Last Codex line cleaner batch was rejected";
    return;
  }

  const count = state.pending.size;
  state.statusBar.text = count > 0 ? `$(wand) Codex Clean ${count}` : "$(wand) Codex Clean";
  state.statusBar.tooltip = count > 0
    ? `${count} completed line(s) pending`
    : "Codex line cleaning is on";
}

function formatError(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = {
  activate,
  deactivate
};
