"use strict";

const assert = require("node:assert/strict");
const Module = require("module");
const path = require("node:path");
const test = require("node:test");

const output = {
  lines: [],
  shown: false,
  appendLine(message) {
    this.lines.push(message);
  },
  show() {
    this.shown = true;
  },
  dispose() {}
};

let configValues = {};

const vscode = {
  StatusBarAlignment: {
    Right: 100
  },
  window: {
    activeTextEditor: undefined,
    informationMessages: [],
    warningMessages: [],
    errorMessages: [],
    createOutputChannel() {
      return output;
    },
    createStatusBarItem() {
      return {
        command: undefined,
        text: "",
        tooltip: "",
        show() {},
        dispose() {}
      };
    },
    showInformationMessage(message) {
      this.informationMessages.push(message);
    },
    showWarningMessage(message) {
      this.warningMessages.push(message);
    },
    showErrorMessage(message) {
      this.errorMessages.push(message);
    }
  },
  commands: {
    registerCommand() {
      return { dispose() {} };
    }
  },
  workspace: {
    appliedEdits: [],
    rejectEdits: false,
    textDocuments: [],
    workspaceFolders: [],
    getConfiguration() {
      return mockConfig(configValues);
    },
    onDidChangeTextDocument() {
      return { dispose() {} };
    },
    async applyEdit(edit) {
      this.appliedEdits.push(edit);
      if (this.rejectEdits) {
        return false;
      }

      for (const replacement of edit.replacements) {
        const document = this.textDocuments.find(
          (candidate) => candidate.uri.toString() === replacement.uri.toString()
        );
        if (document) {
          document._lines[replacement.range.start.line] = replacement.replacement;
        }
      }

      return true;
    }
  },
  WorkspaceEdit: class WorkspaceEdit {
    constructor() {
      this.replacements = [];
    }

    replace(uri, range, replacement) {
      this.replacements.push({ uri, range, replacement });
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") {
    return vscode;
  }

  return originalLoad.call(this, request, parent, isMain);
};

let extension;
try {
  extension = require(path.resolve(__dirname, "..", "extension.js"));
} finally {
  Module._load = originalLoad;
}

const { __test } = extension;

test.beforeEach(() => {
  __test.resetStateForTests();
  output.lines = [];
  output.shown = false;
  configValues = {};
  vscode.workspace.appliedEdits = [];
  vscode.workspace.rejectEdits = false;
  vscode.workspace.textDocuments = [];
  vscode.window.activeTextEditor = undefined;
  vscode.window.informationMessages = [];
  vscode.window.warningMessages = [];
  vscode.window.errorMessages = [];
});

test("countNewlineSequences handles common newline variants", () => {
  assert.equal(__test.countNewlineSequences("one line"), 0);
  assert.equal(__test.countNewlineSequences("one\ntwo"), 1);
  assert.equal(__test.countNewlineSequences("one\r\ntwo\rthree\nfour"), 3);
});

test("buildCodexArgs preserves Codex CLI ordering and configured options", () => {
  const args = __test.buildCodexArgs(
    mockConfig({
      model: " gpt-test ",
      reasoningEffort: "medium"
    }),
    "schema.json",
    "out.json"
  );

  assert.deepEqual(args.slice(0, 3), ["--ask-for-approval", "never", "exec"]);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
    "--model",
    "gpt-test"
  ]);
  assert.equal(args[args.indexOf("-c") + 1], 'model_reasoning_effort="medium"');
  assert.equal(args[args.indexOf("--output-schema") + 1], "schema.json");
  assert.equal(args[args.indexOf("-o") + 1], "out.json");
  assert.equal(args[args.length - 1], "-");
});

test("buildCodexArgs omits blank optional settings", () => {
  const args = __test.buildCodexArgs(
    mockConfig({
      model: "   ",
      reasoningEffort: ""
    }),
    "schema.json",
    "out.json"
  );

  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("-c"), false);
});

test("resolveCodexCommand preserves explicit command overrides", () => {
  assert.equal(__test.isDefaultCodexCommand("codex"), true);
  assert.equal(__test.isDefaultCodexCommand("codex.exe"), true);
  assert.equal(__test.isDefaultCodexCommand("C:\\tools\\codex.exe"), false);
  assert.equal(__test.resolveCodexCommand("C:\\tools\\codex.exe"), "C:\\tools\\codex.exe");
});

test("buildPrompt serializes batch input and extra instructions", () => {
  const prompt = __test.buildPrompt(
    [
      makeBatchItem({
        id: "line-1",
        lineNumber: 3,
        originalText: "teh value",
        context: [
          {
            lineNumber: 4,
            isPendingLine: true,
            text: "teh value"
          }
        ]
      })
    ],
    "Prefer semicolons."
  );

  assert.match(prompt, /Return only JSON matching the provided schema/);
  assert.match(prompt, /"id": "line-1"/);
  assert.match(prompt, /"lineNumber": 4/);
  assert.match(prompt, /"originalText": "teh value"/);
  assert.match(prompt, /Additional user instructions:\nPrefer semicolons\./);
  assert.doesNotMatch(prompt, /```/);
});

test("validateBatchResponse accepts only safe single-line replacements", () => {
  __test.state.output = output;

  const accepted = makeBatchItem({ id: "line-1", originalText: "teh value" });
  const unchanged = makeBatchItem({ id: "line-2", originalText: "already clean" });
  const blank = makeBatchItem({ id: "line-3", originalText: "mess" });
  const multiline = makeBatchItem({ id: "line-4", originalText: "mess" });
  const same = makeBatchItem({ id: "line-5", originalText: "same" });
  const invalid = makeBatchItem({ id: "line-6", originalText: "bad" });
  const changedFalse = makeBatchItem({ id: "line-7", originalText: "teh thing" });
  const batch = [accepted, unchanged, blank, multiline, same, invalid, changedFalse];

  const results = __test.validateBatchResponse(
    {
      results: [
        { id: "line-1", changed: true, replacement: "the value" },
        { id: "line-2", changed: false, replacement: "already clean" },
        { id: "line-3", changed: true, replacement: "   " },
        { id: "line-4", changed: true, replacement: "first\nsecond" },
        { id: "line-5", changed: true, replacement: "same" },
        { id: "line-6", changed: "yes", replacement: "better" },
        { id: "line-7", changed: false, replacement: "the thing" },
        { id: "missing", changed: true, replacement: "ignored" },
        null
      ]
    },
    batch
  );

  assert.deepEqual(results, [
    { item: accepted, replacement: "the value" },
    { item: changedFalse, replacement: "the thing" }
  ]);
  assert.ok(output.lines.some((line) => line.includes("Skipped blank replacement: line-3")));
  assert.ok(output.lines.some((line) => line.includes("Skipped multiline replacement: line-4")));
  assert.ok(output.lines.some((line) => line.includes("Skipped result with invalid fields: line-6")));
  assert.ok(output.lines.some((line) => line.includes("Accepted differing replacement despite changed=false: line-7")));
  assert.ok(output.lines.some((line) => line.includes("Skipped result with unknown id: missing")));
  assert.ok(output.lines.some((line) => line.includes("Skipped malformed result.")));
});

test("validateBatchResponse rejects malformed top-level responses", () => {
  assert.throws(
    () => __test.validateBatchResponse({ result: [] }, []),
    /Codex response did not contain a results array/
  );
});

test("captureCompletedLine records a nonblank line with nearby context", () => {
  const document = createDocument(["alpha", "beta", "gamma"]);

  __test.captureCompletedLine(document, 1);
  __test.captureCompletedLine(createDocument(["   "]), 0);
  __test.captureCompletedLine(document, 10);

  assert.equal(__test.state.pending.size, 1);
  const item = Array.from(__test.state.pending.values())[0];
  assert.equal(item.id, "line-1");
  assert.equal(item.originalText, "beta");
  assert.equal(item.lineNumber, 1);
  assert.deepEqual(
    item.context.map((line) => [line.lineNumber, line.isPendingLine, line.text]),
    [
      [1, false, "alpha"],
      [2, true, "beta"],
      [3, false, "gamma"]
    ]
  );
});

test("takePendingBatch removes only the requested number of queued lines", () => {
  const first = makeBatchItem({ id: "line-1", key: "one" });
  const second = makeBatchItem({ id: "line-2", key: "two" });
  const third = makeBatchItem({ id: "line-3", key: "three" });

  __test.state.pending.set(first.key, first);
  __test.state.pending.set(second.key, second);
  __test.state.pending.set(third.key, third);

  assert.deepEqual(__test.takePendingBatch(2), [first, second]);
  assert.deepEqual(Array.from(__test.state.pending.values()), [third]);
});

test("findManualCleanLineNumber uses the previous line when the current line is blank", () => {
  const document = createDocument(["needs clean", ""]);

  assert.equal(__test.findManualCleanLineNumber(document, 0), 0);
  assert.equal(__test.findManualCleanLineNumber(document, 1), 0);
});

test("applyValidatedResults edits an unchanged open document line", async () => {
  const document = createDocument(["bad grammer"]);
  vscode.workspace.textDocuments = [document];

  const applied = await __test.applyValidatedResults([
    {
      item: makeBatchItem({
        uri: document.uri.toString(),
        originalText: "bad grammer",
        lineNumber: 0
      }),
      replacement: "bad grammar"
    }
  ]);

  assert.equal(applied, 1);
  assert.equal(document.lineAt(0).text, "bad grammar");
  assert.equal(vscode.workspace.appliedEdits.length, 1);
});

test("validate and apply a realistic prose correction", async () => {
  __test.state.output = output;
  const originalText = "Teh grammer in this setnence should be fixed.";
  const replacement = "The grammar in this sentence should be fixed.";
  const document = createDocument([originalText], {
    fsPath: "C:\\workspace\\notes.md",
    languageId: "markdown",
    uriString: "file:///workspace/notes.md"
  });
  const item = makeBatchItem({
    filePath: document.uri.fsPath,
    languageId: document.languageId,
    originalText,
    uri: document.uri.toString()
  });

  vscode.workspace.textDocuments = [document];

  const results = __test.validateBatchResponse(
    {
      results: [
        {
          id: item.id,
          changed: true,
          replacement
        }
      ]
    },
    [item]
  );
  const applied = await __test.applyValidatedResults(results);

  assert.deepEqual(results, [{ item, replacement }]);
  assert.equal(applied, 1);
  assert.equal(document.lineAt(0).text, replacement);
});

test("applyValidatedResults skips a line that changed after capture", async () => {
  __test.state.output = output;
  const document = createDocument(["user edit"]);
  vscode.workspace.textDocuments = [document];

  const applied = await __test.applyValidatedResults([
    {
      item: makeBatchItem({
        uri: document.uri.toString(),
        originalText: "bad grammer",
        lineNumber: 0
      }),
      replacement: "bad grammar"
    }
  ]);

  assert.equal(applied, 0);
  assert.equal(document.lineAt(0).text, "user edit");
  assert.equal(vscode.workspace.appliedEdits.length, 0);
  assert.ok(output.lines.some((line) => line.includes("Skipped changed line: line-1")));
});

test("truncateForLog keeps short text intact and trims long text", () => {
  assert.equal(__test.truncateForLog("short", 10), "short");
  assert.equal(__test.truncateForLog("1234567890", 5), "12345...");
});

function mockConfig(values) {
  return {
    get(key, fallback) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        return values[key];
      }

      return fallback;
    }
  };
}

function createDocument(lines, options = {}) {
  const uriString = options.uriString || "file:///workspace/example.js";
  const uri = {
    scheme: "file",
    fsPath: options.fsPath || "C:\\workspace\\example.js",
    toString() {
      return uriString;
    }
  };

  return {
    _lines: [...lines],
    uri,
    languageId: options.languageId || "javascript",
    get lineCount() {
      return this._lines.length;
    },
    lineAt(index) {
      const text = this._lines[index];
      return {
        text,
        range: {
          start: {
            line: index,
            character: 0
          },
          end: {
            line: index,
            character: text.length
          }
        }
      };
    }
  };
}

function makeBatchItem(overrides = {}) {
  return {
    id: "line-1",
    key: "file:///workspace/example.js:0",
    uri: "file:///workspace/example.js",
    filePath: "C:\\workspace\\example.js",
    lineNumber: 0,
    languageId: "javascript",
    originalText: "const value = 1;",
    context: [],
    ...overrides
  };
}
