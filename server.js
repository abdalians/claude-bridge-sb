#!/usr/bin/env node
// OpenAI-compatible API server — calls Anthropic API directly (no claude CLI subprocess)
// Listens on 0.0.0.0:3456 — restrict externally via firewall

const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')

const PORT = 3456
const HOME = process.env.HOME || '/home/openclaw'
const CREDS_FILE = `${HOME}/.claude/.credentials.json`
const ANTHROPIC_API_HOST = 'api.anthropic.com'
const ANTHROPIC_API_VERSION = '2023-06-01'
const MAX_MESSAGES = 40

const MODEL_MAP = {
    'claude-sonnet-4-6': 'claude-sonnet-4-6',
    'claude-opus-4-7': 'claude-opus-4-7',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001'
}
const DEFAULT_MODEL = 'claude-sonnet-4-6'

function readCreds() {
    try {
        return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
    } catch { return null }
}

function getApiKey() {
    const c = readCreds()
    const token = c?.claudeAiOauth?.accessToken || c?.apiKey
    if (typeof token === 'string' && token.startsWith('sk-ant-')) return token
    return null
}

function updateCredentials(newCreds) {
    fs.mkdirSync(`${HOME}/.claude`, { recursive: true, mode: 0o700 })
    fs.writeFileSync(CREDS_FILE, JSON.stringify(newCreds, null, 2), { mode: 0o600 })
    try { fs.chownSync(CREDS_FILE, 999, 996) } catch {}
}

// Retry delays: 5s, 15s, 30s
const RETRY_DELAYS = [5000, 15000, 30000]

// Convert OpenAI messages array → Anthropic messages array.
// Merges consecutive same-role blocks (Anthropic rejects them).
// Windows to MAX_MESSAGES entries. Strips system messages (handled separately).
function toAnthropicMessages(openaiMessages) {
    const filtered = openaiMessages
        .filter(m => m.role !== 'system')
        .map(m => {
            const text = Array.isArray(m.content)
                ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                : (m.content || '')
            const role = m.role === 'assistant' ? 'assistant' : 'user'
            return { role, content: text }
        })
        .filter(m => m.content.length > 0)

    // Merge consecutive same-role messages
    const merged = []
    for (const msg of filtered) {
        if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
            merged[merged.length - 1].content += '\n\n' + msg.content
        } else {
            merged.push({ role: msg.role, content: msg.content })
        }
    }

    // Anthropic requires the first message to be from user
    while (merged.length > 0 && merged[0].role !== 'user') merged.shift()

    // Window to last MAX_MESSAGES, keeping user-first invariant
    let windowed = merged.slice(-MAX_MESSAGES)
    while (windowed.length > 0 && windowed[0].role !== 'user') windowed.shift()

    return windowed
}

function extractSystem(openaiMessages) {
    return openaiMessages
        .filter(m => m.role === 'system')
        .map(m => Array.isArray(m.content) ? m.content.map(c => c.text).join('\n') : (m.content || ''))
        .join('\n')
        .trim()
}

function callAnthropic(anthropicMessages, systemPrompt, model, onDone, attempt = 0) {
    const apiKey = getApiKey()
    if (!apiKey) {
        onDone(null, 'No API key configured — POST to /token-push or add apiKey to credentials', null)
        return
    }

    const resolvedModel = MODEL_MAP[model] || DEFAULT_MODEL

    const body = {
        model: resolvedModel,
        max_tokens: 8192,
        messages: anthropicMessages
    }

    if (systemPrompt) {
        body.system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    }

    // Cache the last user turn for repeated-prompt workloads
    if (body.messages.length > 0) {
        const last = body.messages[body.messages.length - 1]
        if (last.role === 'user' && typeof last.content === 'string') {
            body.messages[body.messages.length - 1] = {
                role: 'user',
                content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
            }
        }
    }

    const payload = JSON.stringify(body)

    const options = {
        hostname: ANTHROPIC_API_HOST,
        path: '/v1/messages',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
            'anthropic-beta': 'prompt-caching-2024-07-31'
        }
    }

    const req = https.request(options, (res) => {
        let raw = ''
        res.on('data', d => { raw += d })
        res.on('end', () => {
            const status = res.statusCode

            if (status === 429 || status === 529) {
                totalRateLimits++
                let retryAfter = parseInt(res.headers['retry-after'] || '0', 10) * 1000
                const delay = retryAfter > 0 ? retryAfter : (RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1])

                let errDetail = raw.slice(0, 200)
                try {
                    const e = JSON.parse(raw)
                    errDetail = `${e.error?.type || ''}: ${e.error?.message || raw}`.slice(0, 200)
                } catch {}

                if (attempt < RETRY_DELAYS.length) {
                    console.warn(`[bridge] HTTP ${status} rate limit (attempt ${attempt + 1}), retry in ${delay / 1000}s — ${errDetail}`)
                    setTimeout(() => callAnthropic(anthropicMessages, systemPrompt, model, onDone, attempt + 1), delay)
                } else {
                    console.error(`[bridge] HTTP ${status} rate limit — exhausted retries — ${errDetail}`)
                    onDone(null, `HTTP ${status} rate limit after ${attempt} retries: ${errDetail}`, null)
                }
                return
            }

            if (status !== 200) {
                let errDetail = raw.slice(0, 300)
                try {
                    const e = JSON.parse(raw)
                    errDetail = `${e.error?.type || 'unknown'}: ${e.error?.message || raw}`
                } catch {}
                console.error(`[bridge] HTTP ${status} from Anthropic API — ${errDetail}`)
                onDone(null, `HTTP ${status} from Anthropic API — ${errDetail}`, null)
                return
            }

            try {
                const result = JSON.parse(raw)
                const text = (result.content || [])
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('')
                const u = result.usage || {}
                const usage = {
                    prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
                    completion_tokens: u.output_tokens || 0,
                    total_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
                }
                onDone(text, null, usage)
            } catch (parseErr) {
                console.error(`[bridge] Failed to parse Anthropic 200 response: ${parseErr.message} — raw: ${raw.slice(0, 200)}`)
                onDone(null, `Response parse error: ${parseErr.message}`, null)
            }
        })
    })

    req.on('error', (err) => {
        console.error(`[bridge] HTTPS request error (attempt ${attempt + 1}): ${err.message}`)
        if (attempt < RETRY_DELAYS.length) {
            const delay = RETRY_DELAYS[attempt]
            console.warn(`[bridge] Retrying in ${delay / 1000}s`)
            setTimeout(() => callAnthropic(anthropicMessages, systemPrompt, model, onDone, attempt + 1), delay)
        } else {
            onDone(null, `HTTPS error after ${attempt} retries: ${err.message}`, null)
        }
    })

    req.setTimeout(120000, () => {
        req.destroy(new Error('request timeout'))
    })

    req.write(payload)
    req.end()
}

let requestLog = []
let totalRequests = 0
let totalErrors = 0
let totalRateLimits = 0

// Auth status: just check if we have a usable API key
let cachedAuthStatus = 'unknown'
function refreshAuthStatus() {
    cachedAuthStatus = getApiKey() ? 'ok' : 'error'
}
refreshAuthStatus()
setInterval(refreshAuthStatus, 5 * 60 * 1000)

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
        const uptime = process.uptime()
        const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
        const html = `<!DOCTYPE html><html><head><title>Claude Bridge</title><meta charset="utf-8"><style>
body{font-family:monospace;background:#0d1117;color:#e6edf3;margin:0;padding:24px}
h1{color:#f0883e;font-size:18px;margin:0 0 4px}
.sub{color:#8b949e;font-size:12px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.value{font-size:14px;margin-top:4px}
.ok{color:#3fb950}.err{color:#f85149}.warn{color:#e3b341}.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.log{font-size:11px;color:#8b949e;max-height:200px;overflow-y:auto}
.log div{padding:2px 0;border-bottom:1px solid #21262d}
</style></head><body>
<h1>Claude Bridge</h1><div class="sub">OpenAI-compatible proxy → Anthropic API (direct)</div>
<div class="grid">
<div class="card"><div class="label">Status</div><div class="value ok">● Running</div></div>
<div class="card"><div class="label">Auth</div><div class="value ${cachedAuthStatus === 'ok' ? 'ok' : 'err'}">${cachedAuthStatus === 'ok' ? '● API Key OK' : '✗ No API key'}</div></div>
<div class="card"><div class="label">Mode</div><div class="value ok">Direct HTTPS API</div></div>
<div class="card"><div class="label">Uptime</div><div class="value">${uptimeStr}</div></div>
<div class="card"><div class="label">Total Requests</div><div class="value">${totalRequests}</div></div>
<div class="card"><div class="label">Errors</div><div class="value ${totalErrors > 0 ? 'err' : ''}">${totalErrors}</div></div>
<div class="card"><div class="label">Rate Limits (retried)</div><div class="value ${totalRateLimits > 0 ? 'warn' : ''}">${totalRateLimits}</div></div>
<div class="card"><div class="label">Endpoint</div><div class="value">0.0.0.0:${PORT}</div></div>
</div>
<div class="card"><div class="label">Recent Requests</div><div class="log">${requestLog.slice(-20).reverse().map(r => `<div>${r}</div>`).join('') || '<div>No requests yet</div>'}</div></div>
<div class="card"><div class="label">Models</div><div class="value">${Object.keys(MODEL_MAP).join(', ')}</div></div>
</body></html>`
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(html)
        return
    }

    if (req.method === 'GET' && req.url === '/token-status') {
        const apiKey = getApiKey()
        if (apiKey) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, type: 'apikey', permanent: true, expired: false }))
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, type: 'none', message: 'No API key configured' }))
        }
        return
    }

    if (req.method === 'POST' && req.url === '/token-push') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
            try {
                const newCreds = JSON.parse(body)
                if (typeof newCreds.apiKey === 'string' && newCreds.apiKey.startsWith('sk-ant-')) {
                    const expiresAt = newCreds.expiresAt || Date.now() + 365 * 24 * 60 * 60 * 1000
                    updateCredentials({ apiKey: newCreds.apiKey, expiresAt })
                    refreshAuthStatus()
                    console.log('[token-push] api key stored')
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: true, type: 'apikey' }))
                    return
                }
                throw new Error('invalid credentials shape')
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: e.message }))
            }
        })
        return
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            object: 'list',
            data: Object.keys(MODEL_MAP).map(id => ({ id, object: 'model', owned_by: 'anthropic' }))
        }))
        return
    }

    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(404)
        res.end('Not found')
        return
    }

    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
        let parsed
        try { parsed = JSON.parse(body) } catch {
            res.writeHead(400)
            res.end('Bad JSON')
            return
        }

        const { messages = [], model, stream } = parsed
        const anthropicMessages = toAnthropicMessages(messages)
        const systemPrompt = extractSystem(messages)
        totalRequests++
        const reqTime = new Date().toISOString().slice(11, 19)
        const promptSnippet = (anthropicMessages.find(m => m.role === 'user')?.content || '').slice(0, 40)

        if (anthropicMessages.length === 0) {
            res.writeHead(400)
            res.end('No user message')
            return
        }

        if (stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            })

            callAnthropic(anthropicMessages, systemPrompt, model, (text, err, usage) => {
                if (err) totalErrors++
                requestLog.push(`${reqTime} ${model || DEFAULT_MODEL} ${err ? '✗' : '✓'} ${promptSnippet}`)
                if (requestLog.length > 100) requestLog.shift()

                const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex')
                const now = Math.floor(Date.now() / 1000)
                const responseModel = MODEL_MAP[model] || DEFAULT_MODEL

                if (err) {
                    const chunk = { id, object: 'chat.completion.chunk', created: now, model: responseModel, choices: [{ index: 0, delta: { content: err }, finish_reason: null }] }
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
                } else {
                    const chunkSize = 20
                    for (let i = 0; i < text.length; i += chunkSize) {
                        const chunk = { id, object: 'chat.completion.chunk', created: now, model: responseModel, choices: [{ index: 0, delta: { content: text.slice(i, i + chunkSize) }, finish_reason: null }] }
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
                    }
                }

                const doneChunk = { id, object: 'chat.completion.chunk', created: now, model: responseModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`)
                res.write('data: [DONE]\n\n')
                res.end()
            })
        } else {
            callAnthropic(anthropicMessages, systemPrompt, model, (text, err, usage) => {
                if (err) totalErrors++
                requestLog.push(`${reqTime} ${model || DEFAULT_MODEL} ${err ? '✗' : '✓'} ${promptSnippet}`)
                if (requestLog.length > 100) requestLog.shift()

                const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex')
                const now = Math.floor(Date.now() / 1000)
                const responseModel = MODEL_MAP[model] || DEFAULT_MODEL
                const content = err ? `Error: ${err}` : (text || '')

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    id, object: 'chat.completion', created: now, model: responseModel,
                    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                }))
            })
        }
    })
})

server.listen(PORT, '0.0.0.0', () => {
    console.log(`openclaw-claude-bridge v2 (direct API) listening on 0.0.0.0:${PORT}`)
})
