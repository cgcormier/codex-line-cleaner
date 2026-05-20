"use strict";

const childProcess = require("child_process");
const fsSync = require("fs");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const EXTENSION_ID = "codexLineCleaner";
const OUTPUT_NAME = "Codex Line Cleaner";
const MAX_PROCESS_OUTPUT_CHARS = 20000;
const DEFAULT_MAX_BATCH_SIZE = 8;

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
  context: undefined,
  lastError: undefined,
  lastSummary: undefined
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
    vscode.commands.registerCommand(`${EXTENSION_ID}.cleanCurrentLine`, cleanCurrentLine),
    vscode.commands.registerCommand(`${EXTENSION_ID}.runDiagnostics`, runDiagnostics),
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
  state.lastError = undefined;
  state.lastSummary = undefined;

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
  const item = createCompletedLineItem(document, lineNumber);
  if (!item) {
    return;
  }

  state.pending.set(item.key, item);
  updateStatusBar();
}

function createCompletedLineItem(document, lineNumber) {
  if (lineNumber < 0 || lineNumber >= document.lineCount) {
    return undefined;
  }

  const originalText = document.lineAt(lineNumber).text;
  if (originalText.trim().length === 0) {
    return undefined;
  }

  const uri = document.uri.toString();
  const key = `${uri}:${lineNumber}`;
  const id = `line-${state.nextId++}`;

  return {
    id,
    key,
    uri,
    filePath: document.uri.fsPath || uri,
    lineNumber,
    languageId: document.languageId,
    originalText,
    context: getNearbyContext(document, lineNumber)
  };
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

  const batch = takePendingBatch(getMaxBatchSize());

  state.running = true;
  state.lastError = undefined;
  updateStatusBar("running");
  state.output.appendLine(
    `Sending ${batch.length} completed line(s) to Codex. ${state.pending.size} line(s) remain queued.`
  );

  try {
    const parsed = await runCodex(batch);
    if (!state.enabled) {
      return;
    }

    const results = validateBatchResponse(parsed, batch);
    state.output.appendLine(`Codex returned ${parsed.results.length} result(s); ${results.length} safe replacement(s).`);
    const applied = await applyValidatedResults(results, batch);
    state.lastSummary = `Last batch: applied ${applied} of ${batch.length} line(s).`;
    state.output.appendLine(`Applied ${applied} replacement(s).`);
  } catch (error) {
    state.lastError = `Last Codex batch was rejected: ${formatError(error)}`;
    state.output.appendLine(`Rejected Codex batch: ${formatError(error)}`);
    showOutputChannel();
    updateStatusBar("error");
  } finally {
    state.running = false;
    updateStatusBar();

    if (state.enabled && state.pending.size > 0) {
      scheduleFlush();
    }
  }
}

async function cleanCurrentLine() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    showWarningMessage("Codex Line Cleaner: no active editor.");
    return;
  }

  if (state.running) {
    showWarningMessage("Codex Line Cleaner is already checking a line.");
    return;
  }

  const lineNumber = findManualCleanLineNumber(editor.document, editor.selection.active.line);
  const item = createCompletedLineItem(editor.document, lineNumber);
  if (!item) {
    showWarningMessage("Codex Line Cleaner: current line is blank.");
    return;
  }

  state.running = true;
  state.lastError = undefined;
  updateStatusBar("running");
  state.output.appendLine(`Cleaning current line ${item.lineNumber + 1} with Codex.`);

  try {
    const parsed = await runCodex([item]);
    const results = validateBatchResponse(parsed, [item]);
    state.output.appendLine(`Codex returned ${parsed.results.length} result(s); ${results.length} safe replacement(s).`);
    const applied = await applyValidatedResults(results);
    state.lastSummary = `Manual clean: applied ${applied} of 1 line.`;
    state.output.appendLine(`Manual clean applied ${applied} replacement(s).`);
    if (applied === 0) {
      showOutputChannel();
    }
  } catch (error) {
    state.lastError = `Manual clean failed: ${formatError(error)}`;
    state.output.appendLine(state.lastError);
    showOutputChannel();
    showErrorMessage("Codex Line Cleaner manual clean failed. See the Codex Line Cleaner output.");
  } finally {
    state.running = false;
    updateStatusBar();
  }
}

function findManualCleanLineNumber(document, lineNumber) {
  if (lineNumber < 0 || lineNumber >= document.lineCount) {
    return lineNumber;
  }

  if (document.lineAt(lineNumber).text.trim().length > 0) {
    return lineNumber;
  }

  const previousLine = lineNumber - 1;
  if (previousLine >= 0 && document.lineAt(previousLine).text.trim().length > 0) {
    return previousLine;
  }

  return lineNumber;
}

async function runDiagnostics() {
  showOutputChannel();
  state.lastError = undefined;
  state.output.appendLine("");
  state.output.appendLine(`[${new Date().toISOString()}] Running Codex Line Cleaner diagnostics.`);

  const config = getConfig();
  const codexPathSetting = config.get("codexPath", "codex");
  const codexPath = resolveCodexCommand(codexPathSetting);
  state.output.appendLine(`Codex path setting: ${codexPathSetting}`);
  state.output.appendLine(`Resolved Codex command: ${codexPath}`);
  state.output.appendLine(`Workspace cwd: ${getWorkspaceCwd()}`);
  state.output.appendLine(`Extension path: ${state.context && state.context.extensionPath ? state.context.extensionPath : "(unknown)"}`);
  state.output.appendLine(`PATH entries: ${String(process.env.PATH || "").split(path.delimiter).filter(Boolean).length}`);

  try {
    const version = await spawnCodex(codexPath, ["--version"], "", 15000);
    state.output.appendLine(`Codex version: ${version.trim() || "(empty output)"}`);
  } catch (error) {
    state.lastError = `Diagnostics failed while launching Codex: ${formatError(error)}`;
    state.output.appendLine(state.lastError);
    showErrorMessage("Codex Line Cleaner diagnostics failed while launching Codex.");
    updateStatusBar("error");
    return;
  }

  const item = {
    id: "diagnostic-line",
    key: "diagnostic://codex-line-cleaner:0",
    uri: "diagnostic://codex-line-cleaner",
    filePath: "diagnostic",
    lineNumber: 0,
    languageId: "markdown",
    originalText: "teh value",
    context: [
      {
        lineNumber: 1,
        isPendingLine: true,
        text: "teh value"
      }
    ]
  };

  try {
    const parsed = await runCodex([item]);
    state.output.appendLine(`Diagnostic Codex response: ${JSON.stringify(parsed)}`);
    const results = validateBatchResponse(parsed, [item]);
    state.output.appendLine(`Diagnostic safe replacements: ${results.length}`);
    state.lastSummary = "Diagnostics passed.";
    updateStatusBar();
    showInformationMessage("Codex Line Cleaner diagnostics passed. See output for details.");
  } catch (error) {
    state.lastError = `Diagnostics failed while calling Codex: ${formatError(error)}`;
    state.output.appendLine(state.lastError);
    showErrorMessage("Codex Line Cleaner diagnostics failed while calling Codex.");
    updateStatusBar("error");
  }
}

function takePendingBatch(maxBatchSize) {
  const batch = [];

  for (const item of state.pending.values()) {
    batch.push(item);
    if (batch.length >= maxBatchSize) {
      break;
    }
  }

  for (const item of batch) {
    state.pending.delete(item.key);
  }

  return batch;
}

async function runCodex(batch) {
  const config = getConfig();
  const codexPath = resolveCodexCommand(config.get("codexPath", "codex"));
  const schemaPath = state.context.asAbsolutePath("line-fix.schema.json");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-line-cleaner-"));
  const outputFile = path.join(tempDir, "result.json");
  const args = buildCodexArgs(config, schemaPath, outputFile);
  const prompt = buildPrompt(batch, config.get("additionalInstructions", ""));

  try {
    const raw = await spawnCodex(codexPath, args, prompt, getTimeoutMs());
    const output = await fs.readFile(outputFile, "utf8").catch(() => raw);
    try {
      return JSON.parse(output);
    } catch (error) {
      throw new Error(`Codex returned invalid JSON: ${formatError(error)}. Output: ${truncateForLog(output)}`);
    }
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

function resolveCodexCommand(configuredPath) {
  const command = String(configuredPath || "codex").trim() || "codex";
  if (!isDefaultCodexCommand(command)) {
    return command;
  }

  return findBundledCodexCommand() || command;
}

function isDefaultCodexCommand(command) {
  const lower = command.toLowerCase();
  return lower === "codex" || lower === "codex.exe";
}

function findBundledCodexCommand() {
  if (process.platform !== "win32") {
    return undefined;
  }

  const extensionRoots = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions")
  ];
  const candidates = [];

  for (const root of extensionRoots) {
    if (!fsSync.existsSync(root)) {
      continue;
    }

    for (const entry of fsSync.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("openai.chatgpt-")) {
        continue;
      }

      const codexPath = path.join(root, entry.name, "bin", "windows-x86_64", "codex.exe");
      if (fsSync.existsSync(codexPath)) {
        candidates.push(codexPath);
      }
    }
  }

  candidates.sort((left, right) => {
    try {
      const leftTime = fsSync.statSync(left).mtimeMs;
      const rightTime = fsSync.statSync(right).mtimeMs;
      return rightTime - leftTime;
    } catch {
      return 0;
    }
  });

  return candidates[0];
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
      reject(new Error(`Failed to launch Codex command "${command}": ${formatError(error)}`));
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

    if (result.replacement === item.originalText) {
      state.output.appendLine(`Unchanged result: ${item.id}`);
      continue;
    }

    if (!result.changed) {
      state.output.appendLine(`Accepted differing replacement despite changed=false: ${item.id}`);
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

function truncateForLog(text, maxLength = 1000) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

function getConfig() {
  return vscode.workspace.getConfiguration(EXTENSION_ID);
}

function getIdleDelayMs() {
  return Math.max(1000, getConfig().get("idleDelayMs", 5000));
}

function getTimeoutMs() {
  return Math.max(5000, getConfig().get("timeoutMs", 120000));
}

function getMaxBatchSize() {
  return Math.max(1, getConfig().get("maxBatchSize", DEFAULT_MAX_BATCH_SIZE));
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

function showOutputChannel() {
  if (state.output && typeof state.output.show === "function") {
    state.output.show(true);
  }
}

function showInformationMessage(message) {
  if (vscode.window.showInformationMessage) {
    vscode.window.showInformationMessage(message);
  }
}

function showWarningMessage(message) {
  if (vscode.window.showWarningMessage) {
    vscode.window.showWarningMessage(message);
  }
}

function showErrorMessage(message) {
  if (vscode.window.showErrorMessage) {
    vscode.window.showErrorMessage(message);
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

  if (mode === "error" || state.lastError) {
    state.statusBar.text = "$(warning) Codex Clean";
    state.statusBar.tooltip = state.lastError || "Last Codex line cleaner batch was rejected";
    return;
  }

  const count = state.pending.size;
  state.statusBar.text = count > 0 ? `$(wand) Codex Clean ${count}` : "$(wand) Codex Clean";
  state.statusBar.tooltip = count > 0
    ? `${count} completed line(s) pending`
    : state.lastSummary || "Codex line cleaning is on";
}

function formatError(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = {
  activate,
  deactivate,
  __test: {
    state,
    appendLimited,
    applyValidatedResults,
    buildCodexArgs,
    buildPrompt,
    captureCompletedLine,
    createCompletedLineItem,
    countNewlineSequences,
    findManualCleanLineNumber,
    isDefaultCodexCommand,
    resolveCodexCommand,
    getNearbyContext,
    resetStateForTests,
    takePendingBatch,
    truncateForLog,
    validateBatchResponse
  }
};

function resetStateForTests() {
  clearIdleTimer();
  stopCurrentCodexProcess();
  state.enabled = false;
  state.running = false;
  state.pending.clear();
  state.lastEditAt = 0;
  state.nextId = 1;
  state.currentProcess = undefined;
  state.statusBar = undefined;
  state.output = undefined;
  state.context = undefined;
  state.lastError = undefined;
  state.lastSummary = undefined;
}
