# Codex Line Cleaner

Local VS Code extension that watches completed editor lines while enabled, waits for a 5-second idle window, and asks Codex for safe single-line cleanups.

Specialized and intended for notes within VS Code. Applicable to auto-fix typos in coding, uses immediate surrounding lines to build context. No more worrying about missing semicolons ';'   :)

Toggle with `Ctrl+Shift+Alt+C`. The extension is disabled by default.

The bundled Codex command uses low settings by default:

- Model: `gpt-5.4-mini`
- Reasoning effort: `low`
- Sandbox: `read-only`
- Approval policy: `never`

The installed Codex CLI expects `--ask-for-approval never` before the `exec` subcommand, so this extension uses that equivalent argument order.
