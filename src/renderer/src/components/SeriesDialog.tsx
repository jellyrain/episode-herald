import { useEffect, useState } from 'react'
import { Button, Dialog, Spinner, Switch } from '@radix-ui/themes'
import { Check, Layers, Plus } from 'lucide-react'
import type { SeriesDetails, WatchItem } from '../../../shared/types'
import { Tags } from './PageControls'
import { Cover, ErrorBanner } from './Common'
import { messageOf, unwrap } from '../lib'
import styles from '../App.module.css'

export function SeriesDialog({ id, watch, busy, mutationError, onClose, onFollow, onWatchSeasons }: { id: string; watch?: WatchItem; busy: boolean; mutationError: string; onClose(): void; onFollow(id: string): Promise<boolean>; onWatchSeasons(id: string, value: boolean): void }): React.JSX.Element {
  const [details, setDetails] = useState<SeriesDetails | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void window.hongguo.details(id).then(unwrap).then(value => { if (alive) setDetails(value) }).catch(e => { if (alive) setError(messageOf(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, retry])
  const series = details?.series ?? watch?.series
  return <Dialog.Root open onOpenChange={open => !open && onClose()}><Dialog.Content maxWidth="700px" className={styles.detailDialog}>
    <Dialog.Title>{series?.title ?? '作品详情'}</Dialog.Title><Dialog.Description size="2" color="gray">{series ? '作品编号 ' + series.id : '作品详情'}</Dialog.Description>
    {mutationError && <ErrorBanner>{mutationError}</ErrorBanner>}
    {loading && <div className={styles.loadingLine}><Spinner />正在查询作品…</div>}
    {error && <><ErrorBanner>{error}</ErrorBanner><Button variant="soft" onClick={() => setRetry(n => n + 1)}>重试查询</Button></>}
    {series && <div className={styles.detailIntro}>
      <Cover url={series.coverUrl} title={series.title} large />
      <div>
        <Tags items={[...(series.episodeCount === undefined ? [] : [series.episodeCount + ' 集']), ...series.tags]} />
        <p>{series.description || '暂无作品简介。'}</p>
      </div>
    </div>}
    {details?.seasonWarning && <ErrorBanner>{details.seasonWarning}</ErrorBanner>}
    {details && details.seasons.length > 0 && <section className={styles.seasons}><h3><Layers size={17} />关联季 <span>{details.seasons.length}</span></h3><div>{details.seasons.map(season => <div className={styles.seasonRow} key={season.id}><span>{season.index ? `第 ${season.index} 季` : '关联作品'}</span><strong>{season.title}</strong><small>{season.episodeCount ? `${season.episodeCount} 集` : '集数待公布'}</small></div>)}</div></section>}
    {watch && <div className={styles.settingRow}><div><strong id="watch-seasons-label">同时留意新季</strong><p>自动发现关联的新一季，并继续检查其新集。</p></div><Switch checked={watch.watchSeasons} onCheckedChange={value => onWatchSeasons(id, value)} disabled={busy} aria-labelledby="watch-seasons-label" /></div>}
    <div className={styles.dialogActions}><Dialog.Close><Button variant="soft" color="gray">关闭</Button></Dialog.Close><Button disabled={busy || Boolean(watch) || !series} onClick={() => void onFollow(id)}>{watch ? <><Check size={16} />已在追更清单</> : <><Plus size={16} />加入追更</>}</Button></div>
  </Dialog.Content></Dialog.Root>
}
