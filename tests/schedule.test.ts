import assert from 'node:assert/strict'
import test from 'node:test'
import { firstStart, taskWindow, validDraft } from '../src/main/schedule'
import type { ScheduledTask } from '../src/shared/types'

const task: ScheduledTask = { id: 'test', name: '测试', enabled: true, mode: 'changes',
  time: '18:30', frequency: { kind: 'weekly', days: [1, 5] }, startAt: 0 }
const at = (day: number, h: number, m: number): number => new Date(2026, 10, day, h, m).getTime()

test('weekly schedules respect local weekdays, exact times and the creation boundary', () => {
  assert.deepEqual(taskWindow(task, at(9, 18, 30)), { due: at(9, 18, 30), next: at(13, 18, 30) })
  assert.deepEqual(taskWindow({ ...task, startAt: at(10, 9, 0) }, at(10, 10, 0)), { due: undefined, next: at(13, 18, 30) })
  assert.equal(validDraft({ ...task, frequency: { kind: 'weekly', days: [] } }), false)
})

test('intervals start at the requested time and retain their cadence across midnight and missed runs', () => {
  const interval: ScheduledTask = { ...task, frequency: { kind: 'interval', minutes: 37 } }
  interval.startAt = firstStart(interval, at(9, 20, 0))
  assert.equal(interval.startAt, at(10, 18, 30))
  assert.deepEqual(taskWindow(interval, at(10, 18, 0)), { next: interval.startAt })
  assert.deepEqual(taskWindow(interval, at(11, 0, 10)), { due: at(11, 0, 3), next: at(11, 0, 40) })
  assert.equal(validDraft({ ...task, frequency: { kind: 'interval', minutes: 0 } }), false)
})
