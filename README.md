# claude-readable

> One keystroke opens a frosted-glass panel listing your **open Claude Code sessions** — pick one to read its latest response in a clean, roomy reader view. Press again to dismiss.

Long Claude Code answers are hard to read in a dark terminal, squeezed between commands and tool output. `claude-readable` shows your currently-running Claude sessions in a native macOS frosted-glass panel; pick one and its last response renders in a comfortable reader view — serif type, generous line-height, selectable text — then **Esc** and you're back.

It's macOS-native frosted glass (`NSVisualEffectView`), not a browser tab.

> **🛠️ Vibe-coded.** This project was designed, built, and debugged end-to-end by *vibe coding* — a running conversation with [Claude Code](https://www.anthropic.com/claude-code) (Claude Opus 4.8) — rather than typed by hand. Expect a small, pragmatic codebase that grew by iteration.

> _Screenshot: drop a `docs/demo.png` and link it here._

## Requirements

- **macOS** (Apple Silicon or Intel)
- [**Claude Code**](https://www.anthropic.com/claude-code) CLI
- **Homebrew**, **Node 18+**, **Xcode Command Line Tools** (`xcode-select --install`)

Works in any terminal (Warp, iTerm, Terminal.app, Ghostty, …) — it reads Claude Code's own session files, not the terminal's state.

## Install

```sh
git clone https://github.com/<you>/claude-readable ~/.claude-readable
~/.claude-readable/install.sh
```

The installer builds the native panel, links a `readable` command, installs the [`skhd`](https://github.com/koekeishiya/skhd) hotkey daemon, and binds **⌘]**. One manual step (macOS requires it by hand): grant `skhd` **Accessibility** in *System Settings → Privacy & Security → Accessibility*, then `skhd --restart-service`.

## Usage

Press **⌘]** anywhere → a glass panel lists your open Claude sessions, newest first.

| Key | Action |
|---|---|
| **↑ / ↓** | move between sessions |
| **→** / Enter | open the selected session |
| **←** / Backspace | back to the list |
| **✕** / Esc | close the panel |
| **+ / −** | text size |

Theme dots switch paper / white / sepia / soft-dark. Text is selectable (**⌘C**).

Manual command (no hotkey needed):

```sh
readable --glass     # glass panel
readable             # open in your browser instead
readable --print     # print the latest response as markdown
readable --file X    # open one specific .jsonl transcript
```

## How it works

1. **⌘]** → [`skhd`](https://github.com/koekeishiya/skhd) (which grabs the key at the OS level, before any terminal can swallow it) runs `readable`.
2. Claude Code writes `~/.claude/sessions/<pid>.json` for every running CLI process (`{sessionId, cwd, pid, …}`). `readable` keeps the ones whose pid is still alive — your **open sessions**.
3. For each, it finds the transcript `~/.claude/projects/…/<sessionId>.jsonl` and reads it **from the tail** to get the last assistant response (fast even on huge transcripts).
4. It renders the list and each response (markdown → HTML via `marked`) into a borderless **`NSVisualEffectView`** (real macOS vibrancy) hosting a transparent **`WKWebView`**, launched as a floating panel.

```
⌘] ─skhd─▶ readable.mjs ─┬▶ ~/.claude/sessions   (live pids → your open sessions)
                         ├▶ ~/.claude/projects   (last response per session)
                         └▶ marked → HTML ─▶ GlassReader.app  (vibrancy + WKWebView)
```

It's driven entirely by Claude Code's own files — **no terminal-specific integration** — so it works in any terminal. All local, read-only, no network.

## Limitations

- **macOS only** (native vibrancy panel + `skhd` hotkey).
- Lists sessions that are **currently running**; close one and it drops off the list.

## Configure

- **Hotkey:** edit `~/.skhdrc` (default `cmd - 0x1E` = ⌘]; `0x1E` is the `]` keycode), then `skhd --reload`.

## Uninstall

```sh
skhd --stop-service && rm -f ~/.skhdrc
rm -f "$(brew --prefix)/bin/readable"
rm -rf ~/.claude-readable
brew uninstall skhd   # optional
```

## License

MIT — see [LICENSE](LICENSE).
