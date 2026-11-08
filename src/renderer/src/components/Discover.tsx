import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Spinner, TextField } from '@radix-ui/themes'
import { Check, Plus, RefreshCw, Search } from 'lucide-react'
import type { BrowsePage, BrowseQuery, FilterRow, WatchItem } from '../../../shared/types'
import { Choices, PageHeader, Tags, type Choice } from './PageControls'
import { messageOf, unwrap } from '../lib'
import { Cover, EmptyState, ErrorBanner } from './Common'
import styles from '../App.module.css'

const modes: Choice<BrowseQuery['mode']>[] = [
  { value: 'discover', label: '推荐' },
  { value: 'rank', label: '排行榜' },
  { value: 'filter', label: '分类筛选' }
]
const genres = [
  { value: 'short_play', label: '真人剧' },
  { value: 'comic_series', label: '漫剧' },
  { value: 'ai_series', label: 'AI 剧' }
]

function Facet({ label, value, options, disabled, onChange }: {
  label: string
  value: string
  options: Choice[]
  disabled: boolean
  onChange(value: string): void
}): React.JSX.Element {
  return <div className={styles.facet}>
    <span>{label}</span>
    <Choices label={label} options={options} value={value} disabled={disabled} onChange={onChange} limit={6} />
  </div>
}

export function Discover({ watches, busy, onOpen, onFollow }: { watches: WatchItem[]; busy: boolean; onOpen(id: string): void; onFollow(id: string): Promise<boolean> }): React.JSX.Element {
  const [query, selectQuery] = useState<BrowseQuery>({ mode: 'discover' })
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<BrowsePage | null>(null)
  const [ranking, setRanking] = useState<Pick<BrowsePage, 'contents' | 'content' | 'board'>>({})
  const [loading, setLoading] = useState(true)
  const [moreLoading, setMoreLoading] = useState(false)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<FilterRow[]>([])
  const [filterError, setFilterError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [revision, setRevision] = useState(0)
  const requestId = useRef(0)
  const followed = useMemo(() => new Map(watches.map(item => [item.id, item.series.coverUrl])), [watches])
  const followedRef = useRef(followed)
  useEffect(() => { followedRef.current = followed }, [followed])
  const fillSearchCovers = useCallback(async (page: BrowsePage, generation: number): Promise<void> => {
    const ids = page.items.filter(item => !item.coverUrl && !followedRef.current.get(item.id)).map(item => item.id)
    for (let i = 0; i < ids.length && generation === requestId.current; i += 10) {
      try {
        const urls = unwrap(await window.hongguo.searchCovers(ids.slice(i, i + 10)))
        if (generation !== requestId.current) return
        setResult(previous => previous && { ...previous, items: previous.items.map(item =>
          !item.coverUrl && urls[item.id] ? { ...item, coverUrl: urls[item.id] } : item) })
      } catch { /* A failed cover lookup must leave the search results usable. */ }
    }
  }, [])
  const genre = query.genre ?? 'short_play'

  function setQuery(next: BrowseQuery): void {
    setSelected(new Set())
    setResult(null)
    setMoreLoading(false)
    setError('')
    setLoading(next.mode !== 'search' || Boolean(next.query?.trim()))
    if (next.mode === 'filter' && (next === query || next.genre !== query.genre || query.mode !== 'filter')) {
      setRows([])
      setFilterError('')
    }
    if (next === query) setRevision(n => n + 1)
    else selectQuery(next)
  }
  useEffect(() => {
    const current = ++requestId.current
    let alive = true
    if (query.mode === 'search' && !query.query?.trim()) return
    void window.hongguo.browse(query.mode === 'filter' ? { ...query, genre: query.genre ?? 'short_play' } : query).then(unwrap).then(value => {
      if (!alive || current !== requestId.current) return
      setResult(value)
      if (query.mode === 'search') void fillSearchCovers(value, current)
      if (query.mode === 'rank') setRanking({ contents: value.contents, content: value.content, board: value.board })
    }).catch(e => { if (alive && current === requestId.current) setError(messageOf(e)) }).finally(() => { if (alive && current === requestId.current) setLoading(false) })
    return () => { alive = false; requestId.current++ }
  }, [query, revision, fillSearchCovers])

  useEffect(() => {
    if (query.mode !== 'filter') return
    let alive = true
    void window.hongguo.filters(genre).then(unwrap).then(value => { if (alive) setRows(value) }).catch(e => { if (alive) setFilterError(messageOf(e)) })
    return () => { alive = false }
  }, [genre, query.mode, revision])

  const loadMore = async (): Promise<void> => {
    if (!result?.cursor || moreLoading) return
    const current = requestId.current
    setMoreLoading(true)
    setError('')
    try {
      const next = unwrap(await window.hongguo.browse({ ...query, ...(query.mode === 'filter' ? { genre } : {}), cursor: result.cursor }))
      if (current !== requestId.current) return
      setResult(previous => previous ? { ...previous, ...next, items: Array.from(new Map([...previous.items, ...next.items].map(item => [item.id, item])).values()) } : next)
      if (query.mode === 'search') void fillSearchCovers(next, current)
    } catch (e) { if (current === requestId.current) setError(messageOf(e)) }
    finally { if (current === requestId.current) setMoreLoading(false) }
  }
  const addSelected = async (): Promise<void> => {
    setAdding(true)
    try {
      for (const id of selected) {
        if (!followed.has(id) && !(await onFollow(id))) break
        setSelected(current => { const next = new Set(current); next.delete(id); return next })
      }
    } finally { setAdding(false) }
  }
  const selectable = result?.items.filter(item => !followed.has(item.id)) ?? []
  const selectedCount = [...selected].filter(id => !followed.has(id)).length
  const disableActions = busy || adding
  const content = query.content ?? ranking.content ?? ''
  const boards = ranking.contents?.find(item => item.id === content)?.boards ?? []
  const dimensions = rows.filter(row => row.key !== 'genre')
  const primary = dimensions.find(row => row.key === 'category_dim_theme') ?? dimensions[0]
  const secondary = dimensions.filter(row => row !== primary)
  const activeExtras = secondary.flatMap(row => row.options.filter(option =>
    query.selections?.[row.key]?.includes(option.value)).map(option => option.name))

  const renderFacet = (row: FilterRow): React.JSX.Element => (
    <Facet key={genre + row.key} label={row.name} value={query.selections?.[row.key]?.[0] ?? ''}
      options={[{ value: '', label: '全部' }, ...row.options.filter(option => option.value && option.name !== '全部')
        .map(option => ({ value: option.value, label: option.name }))]} disabled={adding}
      onChange={value => {
        const selections = { ...query.selections }
        if (value) selections[row.key] = [value]
        else delete selections[row.key]
        setQuery({ ...query, selections })
      }} />
  )

  const toggleSelection = (id: string, checked: boolean): void => setSelected(current => {
    const next = new Set(current)
    if (checked) next.add(id)
    else next.delete(id)
    return next
  })


  return <>
    <PageHeader title="发现作品">
      <form className={styles.searchForm} onSubmit={event => {
        event.preventDefault()
        if (search.trim() && !adding) setQuery({ mode: 'search', query: search.trim() })
      }}>
        <TextField.Root placeholder="搜索作品名称" value={search}
          onChange={event => setSearch(event.target.value)} aria-label="搜索红果作品">
          <TextField.Slot><Search size={16} /></TextField.Slot>
        </TextField.Root>
        <Button type="submit" variant="surface" disabled={!search.trim() || adding}>搜索</Button>
      </form>
    </PageHeader>
    <div className={styles.toolbar}>
      <Choices label="发现方式" value={query.mode} disabled={adding}
        options={query.mode === 'search' ? [...modes, { value: 'search', label: '搜索结果' }] : modes}
        onChange={mode => setQuery(mode === 'search' ? { mode, query: search.trim() } : { mode })} />
      <Button size="1" variant="ghost" color="gray" disabled={loading || adding}
        onClick={() => setQuery(query)}><RefreshCw size={14} />刷新</Button>
    </div>

    {query.mode === 'rank' && Boolean(ranking.contents?.length) && <section className={styles.filterPanel} aria-label="排行榜条件">
      <Facet label="榜单内容" value={content} disabled={adding}
        options={ranking.contents!.map(item => ({ value: item.id, label: item.name }))}
        onChange={value => setQuery({ mode: 'rank', content: value })} />
      {boards.length > 0 && <Facet label="榜单类型" value={query.board ?? (ranking.content === content ? ranking.board : '') ?? ''}
        disabled={adding} options={boards.map(board => ({ value: board.id, label: board.name }))}
        onChange={value => setQuery({ mode: 'rank', content, board: value })} />}
    </section>}
    {query.mode === 'filter' && <section className={styles.filterPanel} aria-label="分类条件">
      <Facet label="作品类型" value={genre} options={genres} disabled={adding}
        onChange={value => setQuery({ mode: 'filter', genre: value })} />
      {primary && renderFacet(primary)}
      {secondary.length > 0 && <details className={styles.extraFilters}>
        <summary>更多筛选{activeExtras.length > 0 && <span>{activeExtras.join('、')}</span>}</summary>
        {secondary.map(renderFacet)}
      </details>}
      {filterError && <ErrorBanner>{filterError}</ErrorBanner>}
    </section>}
    {error && <ErrorBanner>{error} <button className={styles.textButton}
      onClick={() => result ? void loadMore() : setQuery(query)}>重试</button></ErrorBanner>}
    {loading ? (
      <div className={styles.loadingState} role="status"><Spinner /><span>正在加载作品…</span></div>
    ) : result?.items.length ? <>
      <div className={styles.selectionBar}>
        <label>
          <Checkbox checked={selectable.length > 0 && selectable.every(item => selected.has(item.id)) ? true : selectedCount ? 'indeterminate' : false}
            onCheckedChange={checked => setSelected(checked ? new Set(selectable.map(item => item.id)) : new Set())}
            disabled={disableActions || selectable.length === 0} />
          全选
        </label>
        <span>{selectedCount ? '已选 ' + selectedCount + ' 部' : '已加载 ' + result.items.length + ' 部'}</span>
        {selectedCount > 0 && <Button size="1" variant="soft" disabled={disableActions} onClick={() => void addSelected()}>
          {adding ? <Spinner /> : <Plus size={14} />}追更所选
        </Button>}
      </div>
      <div className={styles.discoverGrid}>
        {result.items.map(item => <article key={item.id} className={styles.discoverCard} data-selected={selected.has(item.id)}>
          <button className={styles.coverButton} onClick={() => onOpen(item.id)} aria-label={'查看' + item.title}>
            <Cover url={item.coverUrl ?? followed.get(item.id)} title={item.title} />
          </button>
          <div className={styles.discoverInfo}>
            <button className={styles.cardTitle} title={item.title} onClick={() => onOpen(item.id)}>{item.title}</button>
            <small>{item.episodeCount === undefined ? '集数待公布' : item.episodeCount + ' 集'}{item.note && ' · ' + item.note}</small>
            <Tags items={item.tags.slice(0, 2)} />
          </div>
          <Checkbox className={styles.pickWork} aria-label={'选择' + item.title} checked={selected.has(item.id)}
            disabled={disableActions || followed.has(item.id)} onCheckedChange={checked => toggleSelection(item.id, checked === true)} />
          <div className={styles.cardFooter}>
            <button className={styles.textButton} onClick={() => onOpen(item.id)}>查看详情</button>
            <Button size="1" variant="soft" color={followed.has(item.id) ? 'gray' : undefined}
              disabled={disableActions || followed.has(item.id)} onClick={() => void onFollow(item.id)}>
              {followed.has(item.id) ? <><Check size={14} />已追更</> : <><Plus size={14} />追更</>}
            </Button>
          </div>
        </article>)}
      </div>
      {result.hasMore && result.cursor && <div className={styles.loadMore}>
        <Button variant="surface" disabled={moreLoading || adding} onClick={() => void loadMore()}>
          {moreLoading && <Spinner />}加载更多
        </Button>
      </div>}
    </> : !error && <EmptyState title="没有匹配的作品" icon={<Search size={24} />}>
      {query.mode === 'search' ? '试试其他作品名称或更短的关键词。' : '可以切换榜单或调整筛选条件。'}
    </EmptyState>}
  </>
}
