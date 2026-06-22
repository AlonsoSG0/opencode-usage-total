# opencode-usage-total 🧠

Track model usage, tokens, and costs per agent in the OpenCode TUI sidebar.

![version](https://img.shields.io/badge/version-0.2.0-muted)

## Features

- Tracks every model used by the main agent and all sub-agents
- Shows the agent or sub-agent, the model, tokens, and cost
- Collapsible sidebar section with `Alt+M` toggle
- Cost and token accumulation across the entire session
- Sub-agent models attributed to the parent session
- Persisted via KV — survives restarts and session switches

## Install

```bash
opencode plugin -g opencode-usage-total
```

## Update

```bash
rm -rf ~/.cache/opencode/packages/opencode-usage-total@latest
opencode plugin -g opencode-usage-total
```

## Usage

Open a session in OpenCode. The sidebar shows a collapsible **🧠 Models** section with every model used in the current session.

Press `Alt+M` to collapse or expand the model list.

![sidebar](https://github.com/AlonsoSG0/opencode-usage-total/raw/main/image.png)

## License

MIT
