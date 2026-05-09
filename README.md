# pi-scream

A minimal usage limits extension for [pi coding agent](https://github.com/mariozechner/pi-coding-agent).

## Demo

`/usage`:

```text
Usage Limits
----------------------------------------
Codex (plus) [premium]
  5h    #######........|.... 33%
  week  ##|................. 8%

https://chatgpt.com/codex/cloud/settings/analytics
```

Footer/status bar:

```text
Codex (plus) #######........|.... 33%
```

The `|` marker indicates reset-window progress. For example, in a 5h window:

- reset in 5h -> marker near 0%
- reset in 1h -> marker near 80%
- reset now -> marker near 100%

## Features

- Shows Codex usage in the footer/status bar.
- Refreshes usage in the background every minute.
- Persists the latest usage cache to `~/.pi/agent/pi-scream-cache.json`.
- Adds a `/usage` command for a compact usage summary.
- Designed to support more providers over time. Codex and Claude provider hooks are included.

## Usage

Install as a pi package or place the extension in your pi extensions directory.

```json
{
  "packages": [
    "github:daya0576/pi-scream"
  ]
}
```

Then reload pi:

```text
/reload
```

Run:

```text
/usage
```

## Local development

This repository lives at:

```text
/Users/henry/repo/private/pi-scream
```

The extension currently loaded by your local pi setup is a separate working copy at:

```text
/Users/henry/.pi/agent/extensions/pi-scream.ts
```

Relationship:

- The repo copy is the publishable package source:

  ```text
  extensions/pi-scream/index.ts
  ```

- The `~/.pi/agent/extensions/pi-scream.ts` copy is the active local extension that pi auto-discovers.
- Right now they are identical, but edits to one do not automatically update the other.
- If you install this repo via `packages` in pi settings, you can remove the standalone local copy to avoid maintaining two copies.

After changing extension files, run:

```text
/reload
```

## Notes

Codex usage is read from ChatGPT's usage endpoint using the `openai-codex` OAuth token already managed by pi.

## License

MIT
