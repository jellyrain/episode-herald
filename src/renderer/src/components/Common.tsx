import { useState, type ReactNode } from 'react'
import { AlertCircle, BookOpen, ImageOff } from 'lucide-react'
import { coverSource } from '../../../shared/covers'
import styles from '../App.module.css'

export function Cover({ url, title, large = false }: { url?: string; title: string; large?: boolean }): React.JSX.Element {
  const [failed, setFailed] = useState('')
  const original = url ? coverSource(url) : ''
  const source = url && failed === original ? url : original
  const [fallbackFailed, setFallbackFailed] = useState('')
  const hasImage = source && failed !== source && fallbackFailed !== source
  return (
    <div className={`${styles.cover} ${large ? styles.coverLarge : ''}`}>
      {hasImage ? <img src={source} alt={title + '的封面'} loading="lazy" referrerPolicy="no-referrer"
        onError={() => source === original ? setFailed(source) : setFallbackFailed(source)} /> :
        <div className={styles.coverFallback} title={url ? '封面加载失败' : '作品暂未提供封面'}>
          <ImageOff size={20} strokeWidth={1.5} /><span>{url ? '加载失败' : '暂无封面'}</span>
        </div>}
    </div>
  )
}

export function EmptyState({ title, children, action, icon }: { title: string; children: ReactNode; action?: ReactNode; icon?: ReactNode }): React.JSX.Element {
  return <div className={styles.empty}><div className={styles.emptyIcon}>{icon ?? <BookOpen size={30} strokeWidth={1.2} />}</div><h2>{title}</h2><p>{children}</p>{action && <div className={styles.emptyActions}>{action}</div>}</div>
}

export function ErrorBanner({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className={styles.error} role="alert"><AlertCircle size={17} /><span>{children}</span></div>
}
