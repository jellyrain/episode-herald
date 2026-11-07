import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, Spinner, Switch } from '@radix-ui/themes'
import { Check, ChevronLeft, Plus } from 'lucide-react'
import type { SeasonCard, SeriesDetails, WatchItem } from '../../../shared/types'
import { Tags } from './PageControls'
import { Cover, ErrorBanner } from './Common'
import { SeasonRows, SimilarShows, SourceNovel } from './DetailExtras'
import { messageOf, unwrap } from '../lib'
import styles from '../App.module.css'

interface SeriesDialogProps {
  id: string
  knownSeasons?: SeasonCard[]
  watches: WatchItem[]
  busy: boolean
  mutationError: string
  previousTitle?: string
  onClose(): void
  onRelated(id: string, previousTitle: string): void
  onSeason(id: string, seasons: SeasonCard[]): void
  onBack?(): void
  onFollow(id: string): Promise<boolean>
  onWatchSeasons(id: string, value: boolean): void
}

export function SeriesDialog({ id, knownSeasons, watches, busy, mutationError, previousTitle, onClose, onRelated, onSeason, onBack, onFollow, onWatchSeasons }: SeriesDialogProps): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [details, setDetails] = useState<SeriesDetails | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    void window.hongguo.details(id).then(unwrap).then(value => { if (alive) setDetails(value) }).catch(e => { if (alive) setError(messageOf(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, retry])
  const seasons = useMemo(() => {
    if (!knownSeasons) return details?.seasons ?? []
    if (!details) return knownSeasons
    const byId = new Map(knownSeasons.map(season => [season.id, season]))
    for (const season of details.seasons) byId.set(season.id, season)
    return [...byId.values()].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
  }, [details, knownSeasons])
  const watch = watches.find(item => item.id === id)
  const seriesWatch = watches.find(item => item.watchSeasons && seasons.some(season => season.id === item.id))
  const series = details?.series ?? watch?.series
  const title = series?.title ?? seasons.find(season => season.id === id)?.title
  const backLabel = previousTitle ? `返回《${previousTitle}》` : '返回上一部'
  return <Dialog.Root open onOpenChange={open => !open && onClose()}><Dialog.Content maxWidth="700px" className={styles.detailDialog}
    onOpenAutoFocus={event => {
      if (onBack && headingRef.current) {
        event.preventDefault()
        headingRef.current.focus({ preventScroll: true })
      }
    }}>
    <header className={styles.detailHeader}>
      <Dialog.Title mb="0" className={styles.detailTitle} ref={headingRef} tabIndex={-1}>{title ?? '作品详情'}</Dialog.Title>
      {onBack && <button type="button" className={styles.detailBack} onClick={onBack} title={backLabel} aria-label={backLabel}>
        <ChevronLeft size={14} aria-hidden="true" />返回
      </button>}
    </header>
    <Dialog.Description size="2" color="gray">{'作品编号 ' + id}</Dialog.Description>
    {mutationError && <ErrorBanner>{mutationError}</ErrorBanner>}
    {loading && <div className={styles.loadingLine}><Spinner />正在查询作品…</div>}
    {error && <><ErrorBanner>{error}</ErrorBanner><Button variant="soft" onClick={() => { setError(''); setLoading(true); setRetry(n => n + 1) }}>重试查询</Button></>}
    {series && <div className={styles.detailIntro}>
      <Cover url={series.coverUrl} title={series.title} large />
      <div>
        <Tags items={[...(series.episodeCount === undefined ? [] : [series.episodeCount + ' 集']), ...series.tags]} />
        <p>{series.description || '暂无作品简介。'}</p>
      </div>
    </div>}
    {details?.seasonWarning && <ErrorBanner>{details.seasonWarning}</ErrorBanner>}
    {seasons.length > 0 && <SeasonRows seasons={seasons} currentId={id} onSelect={next => onSeason(next, seasons)} />}
    {watch && <div className={styles.settingRow}><div><strong id="watch-seasons-label">同时留意新季</strong><p>自动发现关联的新一季，并继续检查其新集。</p></div><Switch checked={watch.watchSeasons} onCheckedChange={value => onWatchSeasons(id, value)} disabled={busy} aria-labelledby="watch-seasons-label" /></div>}
    {details && <><SourceNovel novel={details.originalNovel} /><SimilarShows id={id} onOpen={next => onRelated(next, details.series.title)} /></>}
    <div className={styles.dialogActions}><Dialog.Close><Button variant="soft" color="gray">关闭</Button></Dialog.Close><Button disabled={busy || Boolean(watch || seriesWatch) || !series} onClick={() => void onFollow(id)}>{watch || seriesWatch ? <><Check size={16} />{watch ? '已在追更清单' : seriesWatch?.paused ? '系列追更已暂停' : '已随系列追更'}</> : <><Plus size={16} />加入追更</>}</Button></div>
  </Dialog.Content></Dialog.Root>
}
