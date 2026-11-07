import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { app, nativeImage } from 'electron'

interface DecodedCover { width: number; height: number; data: Uint8ClampedArray }

export async function decodeCover(bytes: Buffer): Promise<Buffer> {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'cover-decoder', 'decode-cover.mjs')
    : fileURLToPath(new URL('../../scripts/decode-cover.mjs', import.meta.url))
  const worker = new Worker(script, { workerData: { bytes, packaged: app.isPackaged } })
  const timer = setTimeout(() => { void worker.terminate() }, 15_000)
  try {
    const { data, width, height } = await new Promise<DecodedCover>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('封面解码进程已结束')))
    })
    const raster = nativeImage.createFromBitmap(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { width, height })
    const scale = Math.min(1, 400 / width, 600 / height)
    const thumbnail = scale < 1 ? raster.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }) : raster
    if (thumbnail.isEmpty()) throw new Error('封面解码失败')
    return thumbnail.toJPEG(87)
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}
