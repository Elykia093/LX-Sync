import { describe, expect, it } from 'vitest'
import { QueueOverflowError, SerialQueue } from './queue.js'

describe('SerialQueue', () => {
  it('runs queued tasks one at a time in submission order', async () => {
    const queue = new SerialQueue({ maxTasks: 8 })
    const events: string[] = []
    const release = Promise.withResolvers<void>()

    queue.push(async () => {
      events.push('first:start')
      await release.promise
      events.push('first:end')
    })
    queue.push(async () => {
      events.push('second')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    expect(queue.pendingTasks).toBe(2)

    release.resolve()
    await flushMicrotasks()
    expect(events).toEqual(['first:start', 'first:end', 'second'])
    expect(queue.pendingTasks).toBe(0)
  })

  it('rejects submissions once the task limit is reached', async () => {
    const queue = new SerialQueue({ maxTasks: 2 })
    const release = Promise.withResolvers<void>()
    queue.push(() => release.promise)
    queue.push(() => release.promise)

    expect(() => queue.push(async () => {})).toThrowError(QueueOverflowError)
    expect(queue.pendingTasks).toBe(2)

    release.resolve()
    await flushMicrotasks()
    expect(queue.pendingTasks).toBe(0)
    expect(() => queue.push(async () => {})).not.toThrow()
  })

  it('rejects submissions that would exceed the byte budget', async () => {
    const queue = new SerialQueue({ maxTasks: 100, maxBytes: 1024 })
    const release = Promise.withResolvers<void>()
    queue.push(() => release.promise, 600)
    expect(queue.pendingBytes).toBe(600)

    expect(() => queue.push(async () => {}, 500)).toThrowError(
      QueueOverflowError,
    )
    expect(() => queue.push(async () => {}, 424)).not.toThrow()
    expect(queue.pendingBytes).toBe(1024)

    release.resolve()
    await flushMicrotasks()
    expect(queue.pendingBytes).toBe(0)
  })

  it('keeps draining and releases capacity after a task rejects', async () => {
    const queue = new SerialQueue({ maxTasks: 4, maxBytes: 64 })
    const events: string[] = []

    queue.push(async () => {
      throw new Error('task failed')
    }, 32)
    queue.push(async () => {
      events.push('after-failure')
    }, 32)

    await flushMicrotasks()
    expect(events).toEqual(['after-failure'])
    expect(queue.pendingTasks).toBe(0)
    expect(queue.pendingBytes).toBe(0)
  })

  it('reports which limit was exceeded', () => {
    const queue = new SerialQueue({ maxTasks: 1, maxBytes: 10 })
    queue.push(() => Promise.withResolvers<void>().promise, 4)

    try {
      queue.push(async () => {}, 1)
      expect.unreachable('expected a queue overflow')
    } catch (error) {
      expect(error).toBeInstanceOf(QueueOverflowError)
      expect((error as QueueOverflowError).reason).toBe('tasks')
      expect((error as QueueOverflowError).limit).toBe(1)
    }
  })

  it('discards waiting work and releases its budget when closed', async () => {
    const queue = new SerialQueue({ maxTasks: 4, maxBytes: 64 })
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    queue.push(async () => {
      events.push('started')
      await release.promise
      events.push('finished')
    }, 24)
    queue.push(async () => {
      events.push('must-not-run')
    }, 40)
    await Promise.resolve()

    queue.close()
    queue.close()
    expect(queue.pendingTasks).toBe(1)
    expect(queue.pendingBytes).toBe(24)
    expect(() => queue.push(async () => {})).toThrow('closed')

    release.resolve()
    await flushMicrotasks()
    expect(events).toEqual(['started', 'finished'])
    expect(queue.pendingTasks).toBe(0)
    expect(queue.pendingBytes).toBe(0)
  })

  it('does not start a task if closed before the queue begins draining', async () => {
    const queue = new SerialQueue({ maxTasks: 1, maxBytes: 8 })
    let ran = false
    queue.push(async () => {
      ran = true
    }, 8)
    queue.close()

    await flushMicrotasks()
    expect(ran).toBe(false)
    expect(queue.pendingTasks).toBe(0)
    expect(queue.pendingBytes).toBe(0)
  })
})

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}
