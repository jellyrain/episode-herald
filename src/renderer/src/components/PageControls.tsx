import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import styles from '../App.module.css'

export function PageHeader({ title, detail, children }: {
  title: string
  detail?: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <header className={styles.pageHeading}>
      <div><h1>{title}</h1>{detail && <p>{detail}</p>}</div>
      {children}
    </header>
  )
}

export interface Choice<T extends string = string> {
  value: T
  label: string
  count?: number
}

export function Choices<T extends string>({ label, options, value, onChange, disabled, limit }: {
  label: string
  options: Choice<T>[]
  value: T
  onChange(value: T): void
  disabled?: boolean
  limit?: number
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const overflow = limit !== undefined && options.length > limit
  const visible = expanded || !overflow ? options : options.filter((option, index) =>
    index < limit || option.value === value)
  return (
    <div className={styles.choices} role="group" aria-label={label}>
      {visible.map(option => (
        <button key={option.value} type="button" disabled={disabled} aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}>
          {option.label}{option.count !== undefined && <small>{option.count}</small>}
        </button>
      ))}
      {overflow && <button type="button" className={styles.moreChoices} aria-expanded={expanded}
        aria-label={(expanded ? '收起' : '展开') + label} onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起' : '更多'}{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>}
    </div>
  )
}

export function Tags({ items }: { items: string[] }): React.JSX.Element | null {
  if (!items.length) return null
  return <div className={styles.tagRow}>{items.map(tag => <span key={tag} title={tag}>{tag}</span>)}</div>
}
