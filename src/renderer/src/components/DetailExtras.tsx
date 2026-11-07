import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Dialog, Spinner } from '@radix-ui/themes'
import { BookOpen, ChevronDown, ChevronRight, BookOpenText, Flame, Layers, Sparkles } from 'lucide-react'
import type { OriginalNovel, SeasonCard, SimilarSeries } from '../../../shared/types'
import { messageOf, unwrap } from '../lib'
import { Cover } from './Common'
import { Tags } from './PageControls'
import styles from '../App.module.css'

const compactHeat = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

async function loadSeasonHeat(id: string): Promise<number | null | 'error'> {
  try {
    return unwrap(await window.hongguo.seasonHeat(id))
  } catch {
    return 'error'
  }
}

export function SeasonRows({ seasons, currentId, onSelect }: {
  seasons: SeasonCard[]; currentId: string; onSelect(id: string): void
}): React.JSX.Element {
  const [showHeat, setShowHeat] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = list.current
    const selected = container?.querySelector('[aria-current="true"]')
    if (!container || !selected) return
    const row = selected.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    if (row.bottom > box.bottom) container.scrollTop += row.bottom - box.bottom + 1
    else if (row.top < box.top) container.scrollTop -= box.top - row.top + 1
  }, [currentId, seasons])
  const requests = useRef(new Map<string, ReturnType<typeof loadSeasonHeat>>())
  const [values, setValues] = useState<Record<string, number | null | 'error'>>({})
  useEffect(() => {
    if (!showHeat) return
    let active = true
    async function load(): Promise<void> {
      // Do not queue a whole album of requests when the user may leave the dialog.
      for (const season of seasons) {
        if (!active) return
        if (season.heat !== undefined) continue
        const pending = requests.current.get(season.id) ?? loadSeasonHeat(season.id)
        requests.current.set(season.id, pending)
        const value = await pending
        if (active) setValues(current => ({ ...current, [season.id]: value }))
      }
    }
    void load()
    return () => { active = false }
  }, [seasons, showHeat])

  async function retry(id: string): Promise<void> {
    setValues(current => {
      const next = { ...current }
      delete next[id]
      return next
    })
    const pending = loadSeasonHeat(id)
    requests.current.set(id, pending)
    const value = await pending
    setValues(current => ({ ...current, [id]: value }))
  }

  return <section className={styles.seasons}>
    <header className={styles.seasonHeading}>
      <h3><Layers size={17} />关联季 <span>{seasons.length}</span></h3>
      <button type="button" className={styles.heatToggle} aria-pressed={showHeat} onClick={() => setShowHeat(!showHeat)}>
        <Flame size={13} aria-hidden="true" />{showHeat ? '收起热度' : '查看热度'}
      </button>
    </header>
    <div ref={list}>{seasons.map(season => {
      const heat = season.heat ?? values[season.id]
      const current = season.id === currentId
      return <div className={styles.seasonRow} key={season.id}>
        <button className={styles.seasonSelect} type="button" aria-current={current || undefined} disabled={current} onClick={() => onSelect(season.id)}>
          <span>{season.index ? `第 ${season.index} 季` : '关联作品'}</span><strong>{season.title}</strong>
          {showHeat && (typeof heat === 'number' ? <small className={styles.heat} title={`红果热度 ${heat.toLocaleString('zh-CN')}`} aria-label={`热度 ${heat}`}>
          <Flame size={14} aria-hidden="true" />{compactHeat.format(heat)}
        </small> : heat === 'error' ? null
          : <small className={styles.heatEmpty}>{heat === null ? '暂无热度' : '读取热度…'}</small>)}
          <small className={styles.seasonEpisodes}>{season.episodeCount ? `${season.episodeCount} 集` : '集数待公布'}</small>
          {current ? <small className={styles.currentSeason}>当前季</small> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
        {showHeat && heat === 'error' && <button type="button" className={styles.heatRetry} onClick={() => void retry(season.id)}>重试热度</button>}
      </div>
    })}</div>
  </section>
}

function DetailSection({ title, icon, children, onExpand }: {
  title: string; icon: ReactNode; children: ReactNode; onExpand?(): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return <section className={styles.detailSection}>
    <h3><button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => {
      if (!open) onExpand?.()
      setOpen(!open)
    }}>{icon}{title}<ChevronDown size={15} className={styles.disclosureArrow} aria-hidden="true" /></button></h3>
    <div id={bodyId} hidden={!open}>{open && children}</div>
  </section>
}

export function SourceNovel({ novel }: { novel?: OriginalNovel }): React.JSX.Element {
  return <DetailSection title="原著小说" icon={<BookOpen size={16} />}>
    {novel ? <div className={styles.novelCard}>
      {novel.coverUrl && <Cover url={novel.coverUrl} title={novel.title ?? '原著小说'} />}
      <div className={styles.novelInfo}><strong>{novel.title || '书名暂未公开'}</strong>
        <Tags items={[...new Set([...(novel.statusLabel ? [novel.statusLabel] : []), ...novel.tags])]} />
        {novel.bookId && <small>书籍编号 {novel.bookId}</small>}
      </div>
      <Dialog.Root>
        <Dialog.Trigger><Button size="1" variant="surface" className={styles.openNovel}><BookOpenText size={14} />查看原著详情</Button></Dialog.Trigger>
        <Dialog.Content maxWidth="480px" className={styles.detailDialog}>
          <Dialog.Description size="2" color="gray" mb="1">原著详情</Dialog.Description>
          <Dialog.Title>{novel.title || '原著小说'}</Dialog.Title>
          <div className={styles.bookDetails}>
            {novel.coverUrl && <Cover url={novel.coverUrl} title={novel.title ?? '原著小说'} large />}
            <dl>
              {novel.shortTitle && <><dt>短标题</dt><dd>{novel.shortTitle}</dd></>}
              {novel.statusLabel && <><dt>创作状态</dt><dd>{novel.statusLabel}</dd></>}
              {novel.tags.length > 0 && <><dt>题材</dt><dd><Tags items={novel.tags} /></dd></>}
              {novel.reads !== undefined && <><dt>阅读数</dt><dd>{novel.reads.toLocaleString('zh-CN')}</dd></>}
              {novel.showAtEpisode !== undefined && <><dt>剧中推荐位置</dt><dd>第 {novel.showAtEpisode} 集</dd></>}
              {novel.bookId && <><dt>书籍编号</dt><dd>{novel.bookId}</dd></>}
            </dl>
          </div>
          <div className={styles.dialogActions}><Dialog.Close><Button variant="surface">返回作品</Button></Dialog.Close></div>
        </Dialog.Content>
      </Dialog.Root>
    </div> : <p className={styles.similarStatus}>红果暂未提供原著信息。</p>}
  </DetailSection>
}

type Recommendations =
  | { state: 'idle' | 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: SimilarSeries[] }

export function SimilarShows({ id, onOpen }: { id: string; onOpen(id: string): void }): React.JSX.Element {
  const [result, setResult] = useState<Recommendations>({ state: 'idle' })
  async function load(): Promise<void> {
    setResult({ state: 'loading' })
    try {
      setResult({ state: 'ready', items: unwrap(await window.hongguo.similarSeries(id)) })
    } catch (error) {
      setResult({ state: 'error', message: messageOf(error) })
    }
  }
  return <DetailSection title="类似剧" icon={<Sparkles size={16} />} onExpand={() => { if (result.state === 'idle') void load() }}>
    {result.state === 'error' ? <div className={styles.similarStatus}>{result.message}<Button size="1" variant="ghost" onClick={() => void load()}>重试推荐</Button></div>
      : result.state !== 'ready' ? <div className={styles.similarStatus}><Spinner size="1" />正在查找同题材作品…</div>
      : !result.items.length ? <p className={styles.similarStatus}>暂无匹配题材的作品。</p>
      : <div className={styles.similarGrid}>{result.items.map(({ series, matchedTags }) =>
        <button key={series.id} type="button" className={styles.similarCard} onClick={() => onOpen(series.id)} aria-label={`查看类似剧：${series.title}`}>
          <Cover url={series.coverUrl} title={series.title} />
          <span><strong>{series.title}</strong><small>{matchedTags.slice(0, 2).join(' · ')}</small></span>
        </button>)}</div>}
  </DetailSection>
}
