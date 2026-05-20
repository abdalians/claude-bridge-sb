#!/usr/bin/env node
// OpenAI-compatible API server wrapping claude CLI
// Listens on 0.0.0.0:3456 — restrict externally via firewall

const http = require('http')
const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')

const PORT            = 3456
const CLAUDE_BIN      = '/bin/claude'
const HOME            = process.env.HOME            || '/home/openclaw'
const TENANTS_BASE    = process.env.TENANTS_BASE    || '/data/clawbridge/tenants'
const WORKSPACES_BASE = process.env.WORKSPACES_BASE || '/data/clawbridge/workspaces'

// Maps saqi-<family> → actual claude model name for --model flag
const FAMILY_MAP = {
    'saqi-max':  'claude-sonnet-4-6',
    'saqi-opus': 'claude-opus-4-7',
    'saqi-fast': 'claude-haiku-4-5',
}

const CREDS_FILE    = `${HOME}/.claude/.credentials.json`
const SETTINGS_FILE = `${HOME}/.claude/settings.json`

function readCreds() {
    try {
        return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
    } catch { return null }
}

function getOAuthExpiresAt() {
    const c = readCreds()
    return c?.claudeAiOauth?.expiresAt || c?.expiresAt || 0
}

function getApiKey() {
    const c = readCreds()
    const token = c?.claudeAiOauth?.accessToken || c?.apiKey
    if (typeof token === 'string' && token.startsWith('sk-ant-')) return token
    return null
}

function isApiKeyMode() {
    return getApiKey() !== null
}

function updateCredentials(newCreds) {
    fs.mkdirSync(`${HOME}/.claude`, { recursive: true, mode: 0o700 })
    fs.writeFileSync(CREDS_FILE, JSON.stringify(newCreds, null, 2), { mode: 0o600 })
    try { fs.chownSync(CREDS_FILE, 999, 996) } catch {}
}

// Tenant registry: slug → { name, ... } loaded from TENANTS_BASE/*/tenant.json
const tenantRegistry = new Map()
function loadTenantRegistry() {
    try {
        const entries = fs.readdirSync(TENANTS_BASE, { withFileTypes: true })
        for (const e of entries) {
            if (!e.isDirectory()) continue
            try {
                const data = JSON.parse(fs.readFileSync(`${TENANTS_BASE}/${e.name}/tenant.json`, 'utf8'))
                tenantRegistry.set(e.name, data)
                console.log(`[tenant] loaded: ${e.name}`)
            } catch { /* skip malformed entries */ }
        }
    } catch (e) {
        console.warn(`[tenant] could not read TENANTS_BASE (${TENANTS_BASE}): ${e.message}`)
    }
}
loadTenantRegistry()

function parseAuthToken(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null
    const token = authHeader.slice(7).trim()
    if (!token.startsWith('sk-')) return null
    const rest = token.slice(3)
    // Match longest tenant slug first to avoid prefix ambiguity
    const slugs = [...tenantRegistry.keys()].sort((a, b) => b.length - a.length)
    for (const slug of slugs) {
        if (rest.startsWith(slug + '-')) {
            const afterTenant = rest.slice(slug.length + 1)
            const lastDash = afterTenant.lastIndexOf('-')
            if (lastDash <= 0) return null
            const agent = afterTenant.slice(0, lastDash)
            if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(agent)) return null
            return { tenant: slug, agent }
        }
    }
    return null
}

function parseModelString(model) {
    if (!model) return null
    const match = model.match(/^(saqi-[a-z0-9]+)-([a-z0-9]([a-z0-9-]*[a-z0-9])?)$/)
    if (!match) return null
    return { family: match[1], agent: match[2] }
}

function respond403(res, code, message) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message, type: 'auth_error', code } }))
}

// Warn when OAuth token is within 90 minutes of expiry (skipped in API key mode)
setInterval(() => {
    if (isApiKeyMode()) return
    const expiresAt = getOAuthExpiresAt()
    const minsLeft = Math.floor((expiresAt - Date.now()) / 60000)
    if (minsLeft < 90 && minsLeft > 0) {
        console.warn(`[token-warn] Claude OAuth token expires in ${minsLeft}m — sync from Mac needed`)
    }
}, 15 * 60 * 1000)

// Auth status cached and refreshed async so dashboard never blocks the event loop
let cachedAuthStatus = 'unknown'
function refreshAuthStatus() {
    const { exec } = require('child_process')
    exec(`${CLAUDE_BIN} --version`, { env: buildClaudeEnv(), timeout: 5000 }, (err) => {
        cachedAuthStatus = err ? 'error' : 'ok'
    })
}
refreshAuthStatus()
setInterval(refreshAuthStatus, 5 * 60 * 1000)

// Rate-limit / overload patterns from Anthropic's error responses
const RATE_LIMIT_RE = /rate.?limit|too.many.requests|usage.limit|overloaded|529|please.try.again|temporarily.unavailable/i

function isRateLimit(text) {
    return RATE_LIMIT_RE.test(text)
}

function buildClaudeEnv(workspacePath = HOME) {
    const agentClaudeDir = `${workspacePath}/.claude`
    try {
        fs.mkdirSync(agentClaudeDir, { recursive: true, mode: 0o700 })
        const credsLink = `${agentClaudeDir}/.credentials.json`
        if (!fs.existsSync(credsLink)) {
            fs.symlinkSync(CREDS_FILE, credsLink)
        }
        const settingsDest = `${agentClaudeDir}/settings.json`
        if (!fs.existsSync(settingsDest)) {
            fs.copyFileSync(SETTINGS_FILE, settingsDest)
        }
    } catch (e) {
        console.warn(`[env] claude dir setup failed for ${workspacePath}: ${e.message}`)
    }
    const env = { ...process.env, HOME: workspacePath }
    const c = readCreds()
    if (typeof c?.apiKey === 'string') env.ANTHROPIC_API_KEY = c.apiKey
    return env
}

function extractText(messages) {
    const parts = []
    for (const msg of messages) {
        if (msg.role === 'system') continue
        const content = Array.isArray(msg.content)
            ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : (msg.content || '')
        if (content) parts.push(`[${msg.role}]: ${content}`)
    }
    return parts.join('\n\n')
}

function extractSystem(messages) {
    return messages
        .filter(m => m.role === 'system')
        .map(m => Array.isArray(m.content) ? m.content.map(c => c.text).join('\n') : m.content)
        .join('\n')
}

// Retry delays for rate-limit backoff: 5s, 15s, 30s
const RETRY_DELAYS = [5000, 15000, 30000]

// Non-streaming: collect all output then callback(text, err, usage)
function runClaude(prompt, systemPrompt, modelFamily, tenantSlug, agentSlug, onDone, attempt = 0) {
    const claudeModel = FAMILY_MAP[modelFamily]
    const workspacePath = `${WORKSPACES_BASE}/${tenantSlug}/workspace-${agentSlug}`
    const args = ["--print", prompt, "--output-format", "json", "--no-session-persistence",
                  "--permission-mode", "acceptEdits",
                  "--add-dir", workspacePath]
    if (claudeModel) args.push('--model', claudeModel)
    if (systemPrompt) args.push('--system-prompt', systemPrompt)
    if (!fs.existsSync(workspacePath)) {
        return void onDone(null, `workspace not found: ${tenantSlug}/${agentSlug}`, null)
    }

    const proc = spawn(CLAUDE_BIN, args, {
        env: buildClaudeEnv(workspacePath),
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 900000
    })

    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })

    // Without this handler an unexpected spawn failure (ENOMEM, ENOENT, etc.)
    // would emit an unhandled 'error' event and crash the server.
    proc.on('error', spawnErr => {
        const msg = spawnErr.message || String(spawnErr)
        console.error(`[bridge] spawn error (attempt ${attempt + 1}): ${msg}`)
        if (attempt < RETRY_DELAYS.length && isRateLimit(msg)) {
            const delay = RETRY_DELAYS[attempt]
            console.warn(`[bridge] rate limit on spawn, retry in ${delay / 1000}s`)
            setTimeout(() => runClaude(prompt, systemPrompt, modelFamily, tenantSlug, agentSlug, onDone, attempt + 1), delay)
        } else {
            onDone(null, `spawn error: ${msg}`, null)
        }
    })

    proc.on('close', code => {
        try {
            const result = JSON.parse(out)
            if (result.is_error) {
                const errMsg = result.result || 'Error from claude'
                if (attempt < RETRY_DELAYS.length && isRateLimit(errMsg)) {
                    const delay = RETRY_DELAYS[attempt]
                    console.warn(`[bridge] rate limit (is_error), retry in ${delay / 1000}s (attempt ${attempt + 1}): ${errMsg.slice(0, 120)}`)
                    totalRateLimits++
                    setTimeout(() => runClaude(prompt, systemPrompt, modelFamily, tenantSlug, agentSlug, onDone, attempt + 1), delay)
                } else {
                    console.error(`[bridge] claude is_error (attempt ${attempt + 1}): ${errMsg.slice(0, 200)}`)
                    onDone(null, errMsg, null)
                }
            } else {
                const u = result.usage || {}
                const usage = {
                    prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
                    completion_tokens: u.output_tokens || 0,
                    total_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
                }
                onDone(result.result || '', null, usage)
            }
        } catch {
            const errMsg = err || out || 'Unknown error'
            if (attempt < RETRY_DELAYS.length && isRateLimit(errMsg)) {
                const delay = RETRY_DELAYS[attempt]
                console.warn(`[bridge] rate limit (no JSON), retry in ${delay / 1000}s (attempt ${attempt + 1}): ${errMsg.slice(0, 120)}`)
                totalRateLimits++
                setTimeout(() => runClaude(prompt, systemPrompt, modelFamily, tenantSlug, agentSlug, onDone, attempt + 1), delay)
            } else {
                console.error(`[bridge] claude no-JSON exit (attempt ${attempt + 1}, code ${code}): ${errMsg.slice(0, 200)}`)
                onDone(null, errMsg, null)
            }
        }
    })
}

// Streaming: uses stream-json --verbose, calls onChunk(text) for each text event,
// then onDone(err, usage) when finished. Metadata lines (tool use, system, etc.) are
// consumed internally and never reach the caller.
function runClaudeStream(prompt, systemPrompt, modelFamily, tenantSlug, agentSlug, onChunk, onDone, attempt = 0, onAbort = null) {
    const claudeModel = FAMILY_MAP[modelFamily]
    const workspacePath = `${WORKSPACES_BASE}/${tenantSlug}/workspace-${agentSlug}`
    const args = ["--print", prompt, "--output-format", "stream-json", "--verbose",
                  "--no-session-persistence",
                  "--permission-mode", "acceptEdits",
                  "--add-dir", workspacePath]
    if (claudeModel) args.push('--model', claudeModel)
    if (systemPrompt) args.push('--system-prompt', systemPrompt)
    if (!fs.existsSync(workspacePath)) {
        return void onDone(`workspace not found: ${tenantSlug}/${agentSlug}`, null)
    }

    const proc = spawn(CLAUDE_BIN, args, {
        env: buildClaudeEnv(workspacePath),
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 900000
    })

    if (onAbort) onAbort(() => { try { proc.kill() } catch (_) {} })

    let lineBuf = ''
    let resultEvent = null
    let hasError = false
    let errorMsg = ''
    let stderrBuf = ''

    proc.stdout.on('data', chunk => {
        lineBuf += chunk.toString()
        let nl
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nl).trim()
            lineBuf = lineBuf.slice(nl + 1)
            if (!line) continue
            let event
            try { event = JSON.parse(line) } catch { continue }

            if (event.type === 'assistant') {
                // Forward text content blocks immediately as they arrive
                const content = event.message?.content || []
                for (const block of content) {
                    if (block.type === 'text' && block.text) {
                        onChunk(block.text)
                    }
                }
            } else if (event.type === 'result') {
                resultEvent = event
                if (event.is_error) {
                    hasError = true
                    errorMsg = event.result || 'Error from claude'
                }
            }
            // system/init, tool_use, tool_result — discard, never forwarded
        }
    })

    proc.stderr.on('data', d => { stderrBuf += d })

    proc.on('error', spawnErr => {
        const msg = spawnErr.message || String(spawnErr)
        console.error(`[bridge] stream spawn error (attempt ${attempt + 1}): ${msg}`)
        if (attempt < RETRY_DELAYS.length && isRateLimit(msg)) {
            const delay = RETRY_DELAYS[attempt]
            console.warn(`[bridge] rate limit on stream spawn, retry in ${delay / 1000}s`)
            setTimeout(() => runClaudeStream(prompt, systemPrompt, modelFamily, tenantSlug, agentSlug, onChunk, onDone, attempt + 1), delay)
        } else {
            onDone(`spawn error: ${msg}`, null)
        }
    })

    proc.on('close', code => {
        if (hasError) {
            if (attempt < RETRY_DELAYS.length && isRateLimit(errorMsg)) {
                totalRateLimits++
                const delay = RETRY_DELAYS[attempt]
                console.warn(`[bridge] rate limit (stream is_error), retry in ${delay / 1000}s (attempt ${attempt + 1})`)
                setTimeout(() => runClaudeStream(prompt, systemPrompt, modelFamily, tenantSlug, agentSlug, onChunk, onDone, attempt + 1), delay)
            } else {
                console.error(`[bridge] claude stream is_error (attempt ${attempt + 1}): ${errorMsg.slice(0, 200)}`)
                onDone(errorMsg, null)
            }
        } else if (resultEvent) {
            const u = resultEvent.usage || {}
            const usage = {
                prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
                completion_tokens: u.output_tokens || 0,
                total_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
            }
            onDone(null, usage)
        } else {
            const errMsg = stderrBuf || lineBuf || 'No result event received'
            if (attempt < RETRY_DELAYS.length && isRateLimit(errMsg)) {
                totalRateLimits++
                const delay = RETRY_DELAYS[attempt]
                console.warn(`[bridge] rate limit (stream no-result), retry in ${delay / 1000}s`)
                setTimeout(() => runClaudeStream(prompt, systemPrompt, modelFamily, tenantSlug, agentSlug, onChunk, onDone, attempt + 1), delay)
            } else {
                console.error(`[bridge] stream no-result exit (attempt ${attempt + 1}, code ${code}): ${errMsg.slice(0, 200)}`)
                onDone(errMsg, null)
            }
        }
    })
}

let requestLog = []
let totalRequests = 0
let totalErrors = 0
let totalRateLimits = 0

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
        const uptime = process.uptime()
        const uptimeStr = `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`
        const apiKeyMode = isApiKeyMode()

        const tenantRows = [...tenantRegistry.keys()].map(slug => {
            let agentCount = 0
            try {
                agentCount = fs.readdirSync(`${WORKSPACES_BASE}/${slug}`).filter(d => d.startsWith('workspace-')).length
            } catch {}
            return `<div class="card"><div class="label">${slug}</div><div class="value">${agentCount} agent${agentCount !== 1 ? 's' : ''}</div></div>`
        }).join('')

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
<h1>Claude Bridge</h1><div class="sub">OpenAI-compatible proxy → Claude CLI</div>
<div class="grid">
<div class="card"><div class="label">Status</div><div class="value ok">● Running</div></div>
<div class="card"><div class="label">Auth</div><div class="value ${cachedAuthStatus === 'ok' ? 'ok' : 'err'}">${cachedAuthStatus === 'ok' ? '● Authenticated' : '✗ Not authenticated'}</div></div>
<div class="card"><div class="label">Mode</div><div class="value">${apiKeyMode ? '🔑 API Key' : '🔐 OAuth'}</div></div>
<div class="card"><div class="label">Uptime</div><div class="value">${uptimeStr}</div></div>
<div class="card"><div class="label">Total Requests</div><div class="value">${totalRequests}</div></div>
<div class="card"><div class="label">Errors</div><div class="value ${totalErrors > 0 ? 'err' : ''}">${totalErrors}</div></div>
<div class="card"><div class="label">Rate Limits (retried)</div><div class="value ${totalRateLimits > 0 ? 'warn' : ''}">${totalRateLimits}</div></div>
<div class="card"><div class="label">Endpoint</div><div class="value">0.0.0.0:${PORT}</div></div>
${tenantRows}
</div>
<div class="card"><div class="label">Recent Requests</div><div class="log">${requestLog.slice(-20).reverse().map(r => `<div>${r}</div>`).join('') || '<div>No requests yet</div>'}</div></div>
<div class="card"><div class="label">Families</div><div class="value">${Object.keys(FAMILY_MAP).join(', ')}</div></div>
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
            return
        }
        const expiresAt = getOAuthExpiresAt()
        const minsLeft = Math.floor((expiresAt - Date.now()) / 60000)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, type: 'oauth', expiresAt, minsLeft, expired: minsLeft < 0 }))
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
            data: Object.keys(FAMILY_MAP).map(id => ({ id, object: 'model', owned_by: 'anthropic' }))
        }))
        return
    }

    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(404)
        res.end('Not found')
        return
    }

    // Validate bearer token before reading body — fail fast on bad credentials
    const auth = parseAuthToken(req.headers['authorization'] || '')
    if (!auth) {
        return void respond403(res, 'unrecognized_credential',
            'Bearer token does not match any known tenant or agent')
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
        const prompt = extractText(messages)
        const systemPrompt = extractSystem(messages)

        if (!prompt) {
            res.writeHead(400)
            res.end('No user message')
            return
        }

        const modelParsed = parseModelString(model)
        if (!modelParsed) {
            return void respond403(res, 'invalid_model', 'Model string must match saqi-<family>-<agent> format')
        }

        if (auth.agent !== modelParsed.agent) {
            console.warn(`[auth] agent mismatch: key=${auth.agent} model=${modelParsed.agent}`)
            return void respond403(res, 'agent_mismatch', 'Bearer credential does not authorize the requested agent')
        }

        const tenantSlug = auth.tenant
        const agentSlug  = auth.agent
        const workspacePath = `${WORKSPACES_BASE}/${tenantSlug}/workspace-${agentSlug}`

        if (!fs.existsSync(workspacePath)) {
            return void respond403(res, 'workspace_not_found', `workspace not found: ${tenantSlug}/${agentSlug}`)
        }

        try {
            const resolvedWorkspace = fs.realpathSync(workspacePath)
            const expectedPrefix    = fs.realpathSync(WORKSPACES_BASE)
            if (!resolvedWorkspace.startsWith(expectedPrefix + '/')) {
                console.error(`[dispatch] workspace path escapes WORKSPACES_BASE: ${resolvedWorkspace}`)
                return void respond403(res, 'path_escape', 'Resolved workspace is outside expected base')
            }
        } catch (e) {
            console.error(`[dispatch] realpathSync failed: ${e.message}`)
            return void respond403(res, 'workspace_error', 'Could not resolve workspace path')
        }

        totalRequests++
        const reqTime = new Date().toISOString().slice(11, 19)
        console.log(`[dispatch] tenant=${tenantSlug} agent=${agentSlug} model=${modelParsed.family} cwd=${workspacePath}`)

        if (stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            })

            const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex')
            const now = Math.floor(Date.now() / 1000)
            const responseModel = FAMILY_MAP[modelParsed.family] || 'claude-sonnet-4-6'

            // Send SSE keepalive comments every 15s so HTTP-layer idle timers don't
            // fire while Claude is calling tools (no text output during that phase).
            // SSE comments are filtered by the SSE parser — they never reach the
            // application layer on the other end, but they do keep the TCP connection
            // alive and reset Undici's bodyTimeout.
            const keepalive = setInterval(() => {
                if (!res.writableEnded) {
                    const hb = { id, object: 'chat.completion.chunk', created: now, model: responseModel,
                                 choices: [{ index: 0, delta: {}, finish_reason: null }] }
                    res.write('data: ' + JSON.stringify(hb) + '\n\n')
                }
            }, 15000)

            let killProc = null
            res.on('close', () => { clearInterval(keepalive) })

            runClaudeStream(
                prompt, systemPrompt, modelParsed.family, tenantSlug, agentSlug,
                (text) => {
                    // Text delta arrives — forward immediately as SSE chunk
                    const chunk = {
                        id, object: 'chat.completion.chunk', created: now, model: responseModel,
                        choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                    }
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
                },
                (err, usage) => {
                    clearInterval(keepalive)
                    if (err) totalErrors++
                    requestLog.push(`${reqTime} [${tenantSlug}/${agentSlug}] ${modelParsed.family} ${err ? '✗' : '✓'} ${prompt.slice(0, 40)}`)
                    if (requestLog.length > 100) requestLog.shift()

                    if (err) {
                        const errChunk = {
                            id, object: 'chat.completion.chunk', created: now, model: responseModel,
                            choices: [{ index: 0, delta: { content: `Error: ${err}` }, finish_reason: null }]
                        }
                        res.write(`data: ${JSON.stringify(errChunk)}\n\n`)
                    }

                    const doneChunk = {
                        id, object: 'chat.completion.chunk', created: now, model: responseModel,
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                    }
                    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`)
                    res.write('data: [DONE]\n\n')
                    res.end()
                },
                0,
                (fn) => { killProc = fn }
            )
        } else {
            runClaude(prompt, systemPrompt, modelParsed.family, tenantSlug, agentSlug, (text, err, usage) => {
                if (err) totalErrors++
                requestLog.push(`${reqTime} [${tenantSlug}/${agentSlug}] ${modelParsed.family} ${err ? '✗' : '✓'} ${prompt.slice(0, 40)}`)
                if (requestLog.length > 100) requestLog.shift()
                const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex')
                const now = Math.floor(Date.now() / 1000)
                const responseModel = FAMILY_MAP[modelParsed.family] || 'claude-sonnet-4-6'
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
    console.log(`openclaw-claude-bridge listening on 0.0.0.0:${PORT}`)
})
