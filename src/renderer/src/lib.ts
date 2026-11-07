import type { Result } from '../../shared/types'

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。'
}

export function dateTime(value?: string): string {
  if (!value) return '尚未检查'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(value))
}
