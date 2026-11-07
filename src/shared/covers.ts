export function coverAddress(value: string): URL | undefined {
  try {
    const url = new URL(value)
    const cdn = /(?:^|\.)(?:fqnovelpic\.com|byteimg\.com|pstatp\.com|toutiaoimg\.com|douyinpic\.com)$/i
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && cdn.test(url.hostname)) {
      return url
    }
  } catch { /* Missing or invalid upstream cover URL. */ }
  return undefined
}

export function coverSource(value: string, afterDecodeError = false): string {
  const url = coverAddress(value)
  if (!url || (!afterDecodeError && !/\.hei[cf]$/i.test(url.pathname))) return value
  return 'hongguo-cover://poster/?' + new URLSearchParams({ src: value }).toString()
}
