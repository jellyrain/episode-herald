import assert from 'node:assert/strict'
import test from 'node:test'
import { coverSource } from '../src/shared/covers'

test('all supported CDN covers use portable storage regardless of their file extension', () => {
  for (const suffix of ['.heic', '.jpg', '.png', '.webp', '']) {
    const source = 'https://p3-reading-sign.fqnovelpic.com/poster' + suffix + '?x-signature=a%2Bb&x-expires=99'
    const request = new URL(coverSource(source))
    assert.equal(request.protocol, 'hongguo-cover:')
    assert.equal(request.searchParams.get('src'), source)
  }
})

test('local placeholders and unrelated hosts are never passed to the cover downloader', () => {
  for (const url of ['data:image/png;base64,AA==', 'https://example.org/poster.jpg',
    'https://fqnovelpic.com.example.org/file.heic', 'https://user:pw@p3.byteimg.com/image']) {
    assert.equal(coverSource(url), url)
  }
})
