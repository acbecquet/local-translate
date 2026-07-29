import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { downloadFile, OLLAMA_STANDALONE_URL } from '../../../src/core/translate/ollama/download'

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Serves `body` in several delayed chunks so onProgress fires more than once. */
function startChunkedServer(
  body: Buffer,
  opts: { setContentLength?: boolean; chunkSize?: number; failAfterBytes?: number } = {}
): Promise<{ server: http.Server; baseUrl: string }> {
  const { setContentLength = true, chunkSize = 4096, failAfterBytes } = opts
  const server = http.createServer((req, res) => {
    if (setContentLength) res.setHeader('content-length', String(body.length))
    let offset = 0
    const sendChunk = () => {
      if (failAfterBytes !== undefined && offset >= failAfterBytes) {
        res.destroy(new Error('simulated network failure'))
        return
      }
      if (offset >= body.length) {
        res.end()
        return
      }
      const end = Math.min(offset + chunkSize, body.length)
      res.write(body.subarray(offset, end))
      offset = end
      setTimeout(sendChunk, 5)
    }
    sendChunk()
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('bad address'))
        return
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` })
    })
    server.on('error', reject)
  })
}

describe('downloadFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lt-download-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the exact bytes served, in order', async () => {
    const body = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(500))
    const { server, baseUrl } = await startChunkedServer(body)
    const dest = path.join(dir, 'out.bin')

    try {
      await downloadFile({ url: `${baseUrl}/file`, dest })
      const written = await readFile(dest)
      expect(Buffer.compare(written, body)).toBe(0)
    } finally {
      server.close()
    }
  })

  it('reports monotonically increasing progress ending at the total byte count', async () => {
    const body = Buffer.from('x'.repeat(200_000))
    const { server, baseUrl } = await startChunkedServer(body, { chunkSize: 8192 })
    const dest = path.join(dir, 'out.bin')
    const calls: Array<{ received: number; total: number | null }> = []

    try {
      await downloadFile({
        url: `${baseUrl}/file`,
        dest,
        onProgress: (received, total) => calls.push({ received, total })
      })
    } finally {
      server.close()
    }

    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) expect(c.total).toBe(body.length)
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].received).toBeGreaterThanOrEqual(calls[i - 1].received)
    }
    expect(calls[calls.length - 1].received).toBe(body.length)
  })

  it('reports total: null when the server omits Content-Length', async () => {
    const body = Buffer.from('no content length here'.repeat(50))
    const { server, baseUrl } = await startChunkedServer(body, { setContentLength: false })
    const dest = path.join(dir, 'out.bin')
    const totals: Array<number | null> = []

    try {
      await downloadFile({
        url: `${baseUrl}/file`,
        dest,
        onProgress: (_received, total) => totals.push(total)
      })
    } finally {
      server.close()
    }

    expect(totals.length).toBeGreaterThan(0)
    expect(totals.every((t) => t === null)).toBe(true)
  })

  it('resolves when expectedSha256 matches', async () => {
    const body = Buffer.from('checksum me please')
    const { server, baseUrl } = await startChunkedServer(body)
    const dest = path.join(dir, 'out.bin')

    try {
      await expect(
        downloadFile({ url: `${baseUrl}/file`, dest, expectedSha256: sha256(body) })
      ).resolves.toBeUndefined()
      expect(existsSync(dest)).toBe(true)
    } finally {
      server.close()
    }
  })

  it('rejects and deletes the file when the sha256 does not match', async () => {
    const body = Buffer.from('this download will be rejected')
    const { server, baseUrl } = await startChunkedServer(body)
    const dest = path.join(dir, 'out.bin')

    try {
      await expect(
        downloadFile({
          url: `${baseUrl}/file`,
          dest,
          expectedSha256: '0'.repeat(64) // deliberately wrong
        })
      ).rejects.toThrow()
      expect(existsSync(dest)).toBe(false)
    } finally {
      server.close()
    }
  })

  it('rejects and deletes the partial file when the connection drops mid-stream', async () => {
    const body = Buffer.from('y'.repeat(200_000))
    const { server, baseUrl } = await startChunkedServer(body, {
      chunkSize: 8192,
      failAfterBytes: 40_000
    })
    const dest = path.join(dir, 'out.bin')

    try {
      await expect(downloadFile({ url: `${baseUrl}/file`, dest })).rejects.toThrow()
      expect(existsSync(dest)).toBe(false)
    } finally {
      server.close()
    }
  })

  it('rejects without writing a file on a 404', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('bad address')
    const dest = path.join(dir, 'out.bin')

    try {
      await expect(
        downloadFile({ url: `http://127.0.0.1:${addr.port}/missing`, dest })
      ).rejects.toThrow()
      expect(existsSync(dest)).toBe(false)
    } finally {
      server.close()
    }
  })
})

describe('OLLAMA_STANDALONE_URL', () => {
  it('points at the latest windows amd64 release zip', () => {
    expect(OLLAMA_STANDALONE_URL).toBe(
      'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip'
    )
  })
})
