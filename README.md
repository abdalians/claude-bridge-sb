# Claude Bridge

An OpenAI-compatible HTTP proxy that wraps the `claude` CLI. Drop it in front of any tool that speaks the OpenAI SDK and point it at Claude instead.

## How it works

- Listens on `0.0.0.0:3456`
- Accepts OpenAI-format chat requests (streaming and non-streaming)
- Translates them into `claude --print` subprocess calls
- Retries on rate limits (429/529/overloaded) with delays of 5 s → 15 s → 30 s
- Surfaces actual error text (HTTP status + error type) in logs and responses

## Why the CLI, not the Anthropic API directly

This service authenticates using a **Claude Max subscription** OAuth token stored in `~/.claude/.credentials.json`. That token is issued by `claude.ai` and is only accepted by the `claude` CLI — it cannot be used against `api.anthropic.com/v1/messages`, which requires a paid API key (`sk-ant-…`).

If you have an `sk-ant-` API key you can store it in the credentials file (see Configuration below) and the bridge will inject it as `ANTHROPIC_API_KEY` for the subprocess. But the subprocess still runs — switching to direct HTTPS calls would require replacing the CLI auth mechanism entirely.

## Token overhead (known limitation)

Every `claude --print` invocation starts a full Claude Code session and loads all built-in tool schemas (Bash, Read, Write, Edit, Grep, WebFetch, etc.) into context — regardless of whether any tools are used. In practice this adds **~17,700 tokens of overhead per request** on top of the actual prompt.

Observed on a one-word "pong" request:

| Token type | Count |
|---|---|
| `input_tokens` (actual prompt) | 6 |
| `cache_creation_input_tokens` | 6,787 |
| `cache_read_input_tokens` (tool schemas, cached) | 17,713 |
| `output_tokens` | 1 |

The tool schemas are cached after the first call (billed at ~1/10th the normal input rate), but they cannot be suppressed while using the CLI. The CLI always initialises its full tool set.

**The only way to eliminate this overhead entirely is to switch to a paid `sk-ant-` Anthropic API key** and rewrite `runClaude()` to call `api.anthropic.com/v1/messages` directly — which also removes the need for the `claude` CLI entirely.

## Prerequisites

- Node.js 18+ (no npm dependencies — stdlib only)
- `claude` CLI installed and authenticated (Claude Max subscription), **or** an `sk-ant-` API key

## Installation

```bash
git clone https://github.com/abdalians/claude-bridge-sb.git /opt/claude-bridge
```

## Configuration

The server reads credentials from `~/.claude/.credentials.json`.

### Claude Max OAuth (default)

If you've already run `claude login` on this machine, the credentials file is already in place. No further configuration is needed.

### API key (sk-ant-…)

Write the file directly:

```bash
mkdir -p ~/.claude && chmod 700 ~/.claude
cat > ~/.claude/.credentials.json <<'EOF'
{
  "apiKey": "sk-ant-YOUR_KEY_HERE",
  "expiresAt": 9999999999999
}
EOF
chmod 600 ~/.claude/.credentials.json
```

Or push the key at runtime without editing any file:

```bash
curl -X POST http://localhost:3456/token-push \
     -H 'Content-Type: application/json' \
     -d '{"apiKey":"sk-ant-YOUR_KEY_HERE"}'
```

## Running

### Direct

```bash
node /opt/claude-bridge/server.js
```

### As a systemd service

```bash
cp claude-bridge.service /etc/systemd/system/
# Edit User= and Environment=HOME= if your service user differs from 'openclaw'
systemctl daemon-reload
systemctl enable --now claude-bridge
```

The service restarts automatically on failure (`Restart=always`, `RestartSec=5`).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` or `/dashboard` | Web dashboard — uptime, stats, recent request log |
| `GET` | `/v1/models` | List available models (OpenAI format) |
| `POST` | `/v1/chat/completions` | Chat completions — OpenAI-compatible, streaming supported |
| `GET` | `/token-status` | Check credential status (OAuth expiry or API key) |
| `POST` | `/token-push` | Push a new `sk-ant-` API key at runtime |

## Supported models

| Model ID | Resolves to |
|----------|-------------|
| `claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `claude-opus-4-7` | `claude-opus-4-7` |
| `claude-haiku-4-5` | `claude-haiku-4-5` |

Default (when no model is specified): `claude-sonnet-4-6`.

## Connecting a client

Point any OpenAI-compatible client at `http://<host>:3456` with a dummy API key:

```bash
curl http://localhost:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'
```

```python
import openai
client = openai.OpenAI(base_url="http://localhost:3456/v1", api_key="unused")
response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello"}]
)
```

## Security note

The server binds to `0.0.0.0:3456` with no authentication. Restrict access at the network level (firewall, VPN, or a reverse proxy with auth) before exposing it beyond localhost.

## Dashboard

Visit `http://<host>:3456/` in a browser for a live status page showing uptime, request counts, error and rate-limit tallies, and a log of the last 20 requests.
