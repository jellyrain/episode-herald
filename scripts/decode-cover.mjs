import { parentPort, workerData } from 'node:worker_threads'

const { default: createModule } = workerData.packaged
  ? await import('./libheif.cjs')
  : await import('libheif-js/libheif-wasm/libheif-bundle.js')
const heif = await createModule()
const images = new heif.HeifDecoder().decode(workerData.bytes)
const image = images[0]
if (!image) throw new Error('封面中没有可解码的图像')
const width = image.get_width()
const height = image.get_height()
if (width < 1 || height < 1 || width * height > 8 * 1024 * 1024) throw new Error('封面尺寸异常')
const data = new Uint8ClampedArray(width * height * 4)
await new Promise((resolve, reject) => {
  image.display({ width, height, data }, result => result ? resolve() : reject(new Error('HEIC 解码失败')))
})
// Electron's bitmap input is BGRA on little-endian hosts. Flatten onto white for JPEG.
for (let i = 0; i < data.length; i += 4) {
  const red = data[i]
  const alpha = data[i + 3] / 255
  const white = 255 - data[i + 3]
  data[i] = data[i + 2] * alpha + white
  data[i + 1] = data[i + 1] * alpha + white
  data[i + 2] = red * alpha + white
  data[i + 3] = 255
}
parentPort.postMessage({ width, height, data }, [data.buffer])
