import { useEffect, useState } from 'react'
import { Button } from '@radix-ui/themes'
import { RefreshCw, Trash2 } from 'lucide-react'
import type { CacheUsage } from '../../../shared/types'
import { messageOf, unwrap } from '../lib'
import styles from '../App.module.css'

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return (bytes / 1024 ** 3).toFixed(2) + ' GB'
}

export function CacheSection(): React.JSX.Element {
  const [usage, setUsage] = useState<CacheUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void window.hongguo.cacheUsage().then(unwrap)
      .then(value => { if (active) setUsage(value) })
      .catch(error => { if (active) setNotice(messageOf(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])
  async function clear(): Promise<void> {
    setClearing(true)
    setNotice('')
    try {
      const result = unwrap(await window.hongguo.clearCache())
      setUsage(result.usage)
      setNotice(`已释放 ${formatSize(result.freed)}。` + (result.skipped ? '部分缓存暂时无法清理，可稍后重试。' : ''))
    } catch (error) { setNotice(messageOf(error)) }
    finally { setClearing(false) }
  }
  const total = usage ? usage.updates + usage.covers + usage.web : 0
  return <section>
    <h2>缓存管理</h2>
    <div className={styles.cachePanel}>
      <div className={styles.cacheHeading}>
        <strong>{loading ? '正在统计…' : usage ? '可清理 ' + formatSize(total) : '暂时无法统计'}</strong>
        <Button size="1" variant="ghost" color="gray" aria-label="刷新缓存占用" title="刷新缓存占用" disabled={loading || clearing}
          onClick={() => { setLoading(true); setNotice(''); setRefresh(value => value + 1) }}><RefreshCw size={14} /></Button>
      </div>
      {usage && <dl className={styles.cacheBreakdown}>
        <div><dt>更新缓存和旧版备份</dt><dd>{formatSize(usage.updates)}</dd></div>
        <div><dt>封面缓存</dt><dd>{formatSize(usage.covers)}</dd></div>
        <div><dt>网页缓存</dt><dd>{formatSize(usage.web)}</dd></div>
      </dl>}
      <p>{usage?.updatesBusy ? '当前更新所需的文件会保留，其他缓存可正常清理。' : '追更记录、推送配置和待安装的更新会保留。'}</p>
      <Button size="2" variant="surface" disabled={loading || clearing || !total} onClick={() => void clear()}>
        <Trash2 size={14} />{clearing ? '正在清理…' : '清理缓存'}
      </Button>
      {notice && <p role="status">{notice}</p>}
      {!!usage?.skipped && <p>部分缓存暂时无法统计。</p>}
    </div>
  </section>
}
