# Claude Bridge

An OpenAI-compatible HTTP proxy that translates `/v1/chat/completions` requests to the Anthropic API. Drop it in front of any tool that speaks the OpenAI SDK and point it at Claude instead.

## How it works

- Listens on `0.0.0.0:3456`
- Accepts OpenAI-format chat requests (streaming and non-streaming)
- Translates them to Anthropic Messages API calls
- Applies prompt caching on the system prompt and the last user turn automatically
- Retries on rate limits (429/529) with delays of 5 s → 15 s → 30 s
- Keeps a sliding window of the last 40 messages to stay within context limits

## Prerequisites

- Node.js 18+ (no npm dependencies — stdlib only)
- An Anthropic API key (`sk-ant-...`)

## Installation

```bash
git clone https://github.com/abdalians/claude-bridge-sb.git /opt/claude-bridge
```

## Configuration

The server reads its API key from `~/.claude/.credentials.json`. There is no `.env` file — see `.env.example` for a full explanation.

### Option A — write the credentials file directly

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

### Option B — push the key via the API (no file editing)

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
# Copy the unit file
cp claude-bridge.service /etc/systemd/system/

# Edit User= and Environment=HOME= if your service user differs from 'openclaw'
# Then enable and start
systemctl daemon-reload
systemctl enable --now claude-bridge
```

The service restarts automatically on failure (`Restart=always`, `RestartSec=5`).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` or `/dashboard` | Web dashboard — live stats and recent request log |
| `GET` | `/v1/models` | List available models (OpenAI format) |
| `POST` | `/v1/chat/completions` | Chat completions — OpenAI-compatible, streaming supported |
| `GET` | `/token-status` | Check whether a valid API key is loaded |
| `POST` | `/token-push` | Push a new API key at runtime |

## Supported models

| Model ID (send this) | Resolves to |
|----------------------|-------------|
| `claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `claude-opus-4-7` | `claude-opus-4-7` |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

Default (when no model is specified): `claude-sonnet-4-6`.

Unknown model IDs also fall back to the default.

## Connecting a client

Point any OpenAI-compatible client at `http://<host>:3456` with a dummy API key:

```bash
# curl
curl http://localhost:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'

# Python (openai SDK)
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
