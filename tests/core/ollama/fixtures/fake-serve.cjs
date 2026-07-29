#!/usr/bin/env node
'use strict'

// Test-only fixture. NOT shipped: used exclusively via the
// OLLAMA_FAKE_SERVE_SCRIPT seam documented in src/core/translate/ollama/lifecycle.ts,
// which spawns `node fake-serve.cjs serve` instead of a real `ollama.exe serve`
// so lifecycle.test.ts never touches a real Ollama install.
//
// Emulates just enough of `ollama serve` for the lifecycle contract:
//   - reads OLLAMA_HOST (host:port), same env var real ollama serve reads
//   - answers GET /api/version with a fake version payload
//   - answers GET /__test/env with the process's OLLAMA_HOST/OLLAMA_MODELS,
//     so tests can assert lifecycle.ts plumbed those env vars correctly
//     without reaching into the child process directly
//   - exits on SIGTERM, SIGINT, or stdin closing, so a killed/detached
//     parent never leaves this fixture orphaned
//
// Written as .cjs (not .ts, not .mjs) so it runs standalone under plain
// `node`, with no ts-node/tsx/loader and no dependency on this repo's
// package.json "type" field.

const http = require('node:http')

const hostPort = process.env.OLLAMA_HOST || '127.0.0.1:11434'
const sepIdx = hostPort.lastIndexOf(':')
const host = sepIdx === -1 ? hostPort : hostPort.slice(0, sepIdx)
const port = Number(sepIdx === -1 ? '11434' : hostPort.slice(sepIdx + 1)) || 11434

const server = http.createServer((req, res) => {
  if (req.url === '/api/version') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: '0.0.0-fake' }))
    return
  }
  if (req.url === '/__test/env') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        OLLAMA_HOST: process.env.OLLAMA_HOST ?? null,
        OLLAMA_MODELS: process.env.OLLAMA_MODELS ?? null
      })
    )
    return
  }
  res.writeHead(404)
  res.end()
})

server.on('error', (err) => {
  // Explicit, rather than relying on the default "unhandled 'error' event
  // throws" behavior: makes the EADDRINUSE (port already occupied) exit
  // path deterministic and gives lifecycle.test.ts's EADDRINUSE test a
  // fast, clean non-zero exit to detect instead of an uncaught-exception
  // stack trace.
  process.stderr.write(`fake-ollama: server error: ${err && err.message ? err.message : err}\n`)
  process.exit(1)
})

server.listen(port, host, () => {
  // Not parsed by lifecycle.ts (which polls /api/version instead) - just
  // useful when a test spawns this fixture directly and wants to log-watch.
  process.stdout.write(`fake-ollama listening on ${host}:${port}\n`)
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  server.close(() => process.exit(0))
  // Belt-and-suspenders: force-exit if close() hangs on a lingering socket.
  setTimeout(() => process.exit(0), 500).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.on('end', shutdown)
process.stdin.resume()
