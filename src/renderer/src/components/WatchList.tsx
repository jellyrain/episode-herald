import { useState } from 'react'
import { AlertDialog, Button, DropdownMenu, TextField, Tooltip } from '@radix-ui/themes'
import { Bell, Ellipsis, Check, CircleAlert, Clock3, Layers, LayoutGrid, Library, List, Pause, Play, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Snapshot, WatchItem } from '../../../shared/types'
import { watchSummary } from '../../../shared/watch-summary'
import { dateTime } from '../lib'
import { Choices, PageHeader } from './PageControls'
import { Cover, EmptyState } from './Common'
import styles from '../App.module.css'
import ui from './WatchList.module.css'

interface Props {
  snapshot: Snapshot
  busy: boolean
  onDiscover(): void
  onOpen(id: string): void
  onCheck(id: string): void
  onToggle(id: string, paused: boolean): void
  onRemove(id: string): void
}

const filters = [
  ['all', '全部'], ['updates', '有更新'], ['reservable', '可预约'], ['active', '追更中'], ['paused', '已暂停'], ['error', '需重试']
] as const
type Filter = typeof filters[number][0]
type Summary = ReturnType<typeof watchSummary>

function matchesFilter(item: WatchItem, summary: Summary, filter: Filter): boolean {
  switch (filter) {
    case 'updates': return summary.unread > 0
    case 'reservable': return item.watchSeasons && Boolean(item.reservationSeasons?.length)
    case 'active': return !item.paused
    case 'paused': return item.paused
    case 'error': return Boolean(item.lastError)
    case 'all': return true
  }
}

function ToolButton({ label, icon: Icon, onClick, disabled, pressed }: {
  label: string
  icon: LucideIcon
  onClick(): void
  disabled?: boolean
  pressed?: boolean
}): React.JSX.Element {
  return <Tooltip content={label}>
    <button type="button" className={ui.iconButton} aria-label={label} aria-pressed={pressed}
      disabled={disabled} onClick={onClick}>
      <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
    </button>
  </Tooltip>
}

function CheckResult({ item, summary }: { item: WatchItem; summary: Summary }): React.JSX.Element {
  const { highlight, result, unread } = summary
  const sameCheck = highlight && highlight.createdAt === item.lastCheckedAt
  const currentOnly = !highlight || !sameCheck || Boolean(item.lastError)
  const stateIcon = item.lastError ? <CircleAlert size={15} /> : item.baselineReady ? <Check size={15} /> : <Clock3 size={15} />
  return <div className={ui.result}>
    {highlight && <div className={ui.news}>
      {highlight.kind === 'season' ? <Layers size={16} /> : <Bell size={16} />}
      <div>
        <strong>{highlight.kind === 'season' ? '发现新季 · ' + highlight.title : highlight.message.replace(/。$/, '')}</strong>
        <small>{highlight.kind === 'season' && item.reservationSeasons?.some(s => s.id === highlight.seriesId) && '手机端可预约 · '}
          {highlight.kind === 'episodes' && highlight.seriesId !== item.id && highlight.title + ' · '}
          {dateTime(highlight.createdAt)}{unread ? ' · ' + unread + ' 条未读' : ' · 已读'}
        </small>
      </div>
    </div>}
    {currentOnly && <div className={ui.checkState} data-warning={Boolean(item.lastError)}>
      {stateIcon}<span>{result}</span>
      {item.lastCheckedAt && <time dateTime={item.lastCheckedAt}>{dateTime(item.lastCheckedAt)}</time>}
    </div>}
    {item.lastError && <p className={ui.errorText}>{item.lastError}</p>}
  </div>
}

export function WatchList({ snapshot, busy, onDiscover, onOpen, onCheck, onToggle, onRemove }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [grid, setGrid] = useState(() => localStorage.getItem('watch-view') === 'grid')
  const changeView = (next: boolean): void => {
    setGrid(next)
    localStorage.setItem('watch-view', next ? 'grid' : 'list')
  }
  const [removing, setRemoving] = useState<WatchItem | null>(null)
  const rows = snapshot.watches.map(item => ({ item, summary: watchSummary(item, snapshot.events) }))
  const counts = (key: Filter): number => rows.filter(({item, summary}) => matchesFilter(item, summary, key)).length
  const search = query.trim().toLocaleLowerCase()
  const visible = rows.filter(({item, summary}) => matchesFilter(item, summary, filter) &&
    item.series.title.toLocaleLowerCase().includes(search))
  visible.sort((a, b) => Number(b.summary.unread > 0) - Number(a.summary.unread > 0) ||
    (a.summary.unread && b.summary.unread ? b.summary.highlight!.createdAt.localeCompare(a.summary.highlight!.createdAt) : 0))
  const clearFilter = (): void => { setQuery(''); setFilter('all') }

  return <>
    <PageHeader title="我的追更" detail={rows.length + ' 部作品' + (counts('updates') ? ' · ' + counts('updates') + ' 部有未读更新' : '')}>
      <Button onClick={onDiscover}><Plus size={16} />添加作品</Button>
    </PageHeader>
    <div className={styles.toolbar}>
      <Choices<Filter> label="筛选追更作品" value={filter} onChange={setFilter}
        options={filters.map(([value, label]) => ({ value, label, count: counts(value) }))} />
      <div className={ui.tools}>
        <TextField.Root aria-label="搜索已关注作品" placeholder="搜索作品" value={query}
          onChange={event => setQuery(event.target.value)}>
          <TextField.Slot><Search size={15} /></TextField.Slot>
        </TextField.Root>
        <div className={ui.viewSwitch} role="group" aria-label="作品视图">
          <ToolButton label="列表视图" icon={List} pressed={!grid} onClick={() => changeView(false)} />
          <ToolButton label="卡片视图" icon={LayoutGrid} pressed={grid} onClick={() => changeView(true)} />
        </div>
      </div>
    </div>

    {visible.length === 0 ? <EmptyState
      title={!rows.length ? '还没有追更作品' : filter === 'reservable' && !query ? '暂无可预约作品' : filter === 'updates' && !query ? '没有未读更新' : '没有匹配的作品'}
      icon={<Library size={30} strokeWidth={1.5} />}
      action={<Button variant="soft" onClick={rows.length ? clearFilter : onDiscover}>
        {rows.length ? '查看全部作品' : '去发现作品'}
      </Button>}>
      {!rows.length ? '加入作品后，首次检查会记录已有的季和集。' : filter === 'reservable' && !query ? '检查到可预约的新季时，作品会出现在这里。' : filter === 'updates' && !query ? '新发现的季和分集会显示在这里。' : '可以调整上方筛选或搜索关键词。'}
    </EmptyState> : <div className={grid ? ui.grid : ui.list}>
      {visible.map(({ item, summary }) => <article key={item.id} className={ui.card} data-unread={summary.unread > 0}>
        <button className={ui.poster} onClick={() => onOpen(item.id)} aria-label={'查看' + item.series.title}>
          <Cover url={item.series.coverUrl} title={item.series.title} />
        </button>
        <div className={ui.identity}>
          <h2><button onClick={() => onOpen(item.id)}>{item.series.title}</button></h2>
          <p>{item.series.episodeCount === undefined ? '集数待公布' : '已收录 ' + item.series.episodeCount + ' 集'}
            {item.seasonCount > 1 && ' · 关联 ' + item.seasonCount + ' 季'}
          </p>
          <span className={ui.watchMode}>{item.paused ? '已暂停追更' : item.watchSeasons ? '监控新季与新集' : '监控本季新集'}</span>
        </div>
        <CheckResult item={item} summary={summary} />
        <div className={ui.actions}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <button type="button" className={ui.iconButton} aria-label={'管理' + item.series.title} title="管理作品">
                <Ellipsis size={18} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" size="2">
              <DropdownMenu.Item disabled={busy} onSelect={() => onCheck(item.id)}><RefreshCw size={15} />立即检查</DropdownMenu.Item>
              <DropdownMenu.Item disabled={busy} onSelect={() => onToggle(item.id, !item.paused)}>
                {item.paused ? <Play size={15} /> : <Pause size={15} />}{item.paused ? '继续追更' : '暂停追更'}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item color="red" disabled={busy} onSelect={() => setRemoving(item)}>
                <Trash2 size={15} />取消追更
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      </article>)}
    </div>}

    <AlertDialog.Root open={Boolean(removing)} onOpenChange={open => !open && setRemoving(null)}>
      <AlertDialog.Content maxWidth="420px">
        <AlertDialog.Title>取消追更这部作品？</AlertDialog.Title>
        <AlertDialog.Description size="2">将停止检查《{removing?.series.title}》。已有更新记录会保留。</AlertDialog.Description>
        <div className={styles.dialogActions}>
          <AlertDialog.Cancel><Button variant="soft" color="gray">继续追更</Button></AlertDialog.Cancel>
          <AlertDialog.Action><Button color="red" disabled={busy} onClick={() => removing && onRemove(removing.id)}>取消追更</Button></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Root>
  </>
}
