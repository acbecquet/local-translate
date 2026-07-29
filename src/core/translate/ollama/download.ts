import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'

/** Windows amd64 zip of the latest Ollama release, for standalone (managed) installs. */
export const OLLAMA_STANDALONE_URL =
  'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip'

/**
 * Streams `url` to `dest`, reporting progress and optionally verifying a
 * sha256 checksum. On any failure (HTTP error, stream error, or checksum
 * mismatch) `dest` is removed before rejecting, so callers never see a
 * half-written file left behind.
 */
export async function downloadFile(opts: {
  url: string
  dest: string
  expectedSha256?: string
  onProgress?: (received: number, total: number | null) => void
}): Promise<void> {
  const res = await fetch(opts.url)
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} (${opts.url})`)
  }

  const contentLength = res.headers.get('content-length')
  const total = contentLength !== null && contentLength !== '' ? Number(contentLength) : null

  const hash = createHash('sha256')
  let received = 0
  const track = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      received += chunk.length
      hash.update(chunk)
      opts.onProgress?.(received, total)
      callback(null, chunk)
    }
  })

  const source = fromWebStream(res.body)

  try {
    await pipeline(source, track, createWriteStream(opts.dest))
  } catch (err) {
    await unlink(opts.dest).catch(() => {})
    throw err
  }

  if (opts.expectedSha256) {
    const actual = hash.digest('hex')
    if (actual.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
      await unlink(opts.dest).catch(() => {})
      throw new Error(
        `Checksum mismatch downloading ${opts.url}: expected ${opts.expectedSha256}, got ${actual}`
      )
    }
  }
}

// fetch()'s Response.body is a web ReadableStream (from the DOM/whatwg-streams
// lib). node:stream/promises.pipeline wants Node streams, so bridge it once
// here via Readable.fromWeb rather than scattering the cast at call sites.
function fromWebStream(body: NonNullable<Response['body']>): NodeJS.ReadableStream {
  return Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>)
}
