import { useState } from 'react'
import { Button, Switch, TextField } from '@radix-ui/themes'
import { CalendarClock, Plus } from 'lucide-react'
import type { Snapshot, TaskDraft, TaskFrequency } from '../../../shared/types'
import { Choices, PageHeader } from './PageControls'
import { EmptyState } from './Common'
import { dateTime } from '../lib'
import styles from './SchedulePage.module.css'

const weekdays = ['日', '一', '二', '三', '四', '五', '六']
const fresh = (): TaskDraft => ({ name: '', mode: 'changes', enabled: true, time: '09:00', frequency: { kind: 'daily' } })
const modeNames = { changes: '检查更新', full: '全量更新' }

function cadence(task: TaskDraft): string {
  const f = task.frequency
  if (f.kind === 'interval') return `每 ${f.minutes} 分钟`
  return (f.kind === 'daily' ? '每天' : '周' + f.days.map(day => weekdays[day]).join('、')) + ' ' + task.time
}

interface ScheduleProps {
  tasks: Snapshot['tasks']
  busy: boolean
  saveTask(task: TaskDraft, id?: string): Promise<boolean>
  removeTask(id: string): Promise<boolean>
}

export function SchedulePage({ tasks, busy, saveTask, removeTask }: ScheduleProps): React.JSX.Element {
  const [editor, setEditor] = useState<{ id?: string; draft: TaskDraft }>()
  const draft = editor?.draft
  const update = (changes: Partial<TaskDraft>): void => setEditor(old => old && ({ ...old, draft: { ...old.draft, ...changes } }))
  function selectFrequency(kind: TaskFrequency['kind']): void {
    if (kind === draft?.frequency.kind) return
    update({ frequency: kind === 'interval' ? { kind, minutes: 60 } : kind === 'weekly' ? { kind, days: [1] } : { kind } })
  }
  return <>
    <PageHeader title="调度任务" detail="按本机时间检查追更。收起到托盘后继续执行，错过的检查会在启动或唤醒后补查。">
      {!editor && <Button disabled={busy} onClick={() => setEditor({ draft: fresh() })}><Plus size={15} />新建任务</Button>}
    </PageHeader>
    {editor && draft ? <form className={styles.card} aria-labelledby="task-editor-title" onSubmit={async event => {
      event.preventDefault()
      if (await saveTask(draft, editor.id)) setEditor(undefined)
    }}>
      <h2 className={styles.formTitle} id="task-editor-title">{editor.id ? '编辑任务' : '新建任务'}</h2>
      <div className={styles.fields}>
        <div className={styles.row}>
          <label htmlFor="task-name">任务名称</label>
          <TextField.Root id="task-name" className={styles.nameInput} autoFocus required maxLength={80} placeholder="例如：周末全量复查" value={draft.name} onChange={e => update({ name: e.target.value })} />
        </div>
        <div className={styles.row}><span>检查方式</span><div>
          <Choices label="检查方式" value={draft.mode} options={[{ value: 'changes', label: modeNames.changes }, { value: 'full', label: modeNames.full }]} onChange={mode => update({ mode })} />
          <p className={styles.hint}>{draft.mode === 'full' ? '逐季核对所有分集，发现新季或新集时推送。' : '按日常规则检查，发现新季或新集时推送。'}</p>
        </div></div>
        <div className={styles.divider} />
        <div className={styles.row}><span>执行频率</span>
          <Choices label="执行频率" value={draft.frequency.kind} options={[{ value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }, { value: 'interval', label: '固定间隔' }]} onChange={selectFrequency} />
        </div>
        {draft.frequency.kind === 'weekly' && <div className={styles.row}><span>执行日</span><div className={styles.days} role="group" aria-label="执行日">
          {[1, 2, 3, 4, 5, 6, 0].map(day => {
            const days = draft.frequency.kind === 'weekly' ? draft.frequency.days : []
            const selected = days.includes(day)
            return <Button key={day} type="button" size="1" aria-pressed={selected} variant={selected ? 'solid' : 'surface'} onClick={() =>
              update({ frequency: { kind: 'weekly', days: selected ? days.filter(d => d !== day) : [...days, day].sort((a,b) => (a + 6) % 7 - (b + 6) % 7) } })}>周{weekdays[day]}</Button>
          })}
        </div></div>}
        {draft.frequency.kind === 'interval' && <div className={styles.row}>
          <label htmlFor="task-minutes">间隔分钟数</label>
          <TextField.Root id="task-minutes" className={styles.shortInput} type="number" required min={1} max={10080} value={draft.frequency.minutes || ''} onChange={e => update({ frequency: { kind: 'interval', minutes: Number(e.target.value) } })} />
        </div>}
        <div className={styles.row}>
          <label htmlFor="task-time">{draft.frequency.kind === 'interval' ? '首次执行时间' : '执行时间'}</label>
          <TextField.Root id="task-time" className={styles.shortInput} required type="time" value={draft.time} onChange={e => update({ time: e.target.value })} />
        </div>
      </div>
      <footer className={styles.formActions}>
        <Button type="button" variant="surface" color="gray" onClick={() => setEditor(undefined)}>取消</Button>
        <Button type="submit" disabled={busy || !draft.name.trim() || (draft.frequency.kind === 'weekly' && !draft.frequency.days.length)}>保存任务</Button>
      </footer>
    </form> : tasks.length ? <div className={styles.card}>
      <table className={styles.tasks} aria-label="调度任务列表">
        <thead><tr><th scope="col">任务名称</th><th scope="col">执行计划</th><th scope="col">下次执行</th><th scope="col">操作</th></tr></thead>
        <tbody>{tasks.map(task => <tr key={task.id}>
          <td><strong>{task.name}</strong><small>{modeNames[task.mode]}</small></td>
          <td>{cadence(task)}</td>
          <td>{task.enabled && task.nextAt ? <time dateTime={new Date(task.nextAt).toISOString()}>{dateTime(new Date(task.nextAt).toISOString())}</time> : '已暂停'}</td>
          <td><div className={styles.taskActions}>
            <Switch aria-label={'启用' + task.name} checked={task.enabled} disabled={busy} onCheckedChange={enabled => void saveTask({ ...task, enabled }, task.id)} />
            <Button size="1" variant="surface" disabled={busy} onClick={() => setEditor({ id: task.id, draft: task })}>编辑</Button>
            <Button size="1" variant="soft" color="gray" disabled={busy} onClick={() => void removeTask(task.id)}>删除</Button>
          </div></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState title="暂无调度任务" icon={<CalendarClock size={24} />}>新建任务后，可在这里查看下次执行时间。</EmptyState>}
  </>
}
