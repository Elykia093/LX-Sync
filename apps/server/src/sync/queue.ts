export class QueueOverflowError extends Error {
  constructor(
    readonly reason: 'tasks' | 'bytes',
    readonly limit: number,
  ) {
    super(`LX serial queue ${reason} limit exceeded`)
    this.name = 'QueueOverflowError'
  }
}

export interface SerialQueueLimits {
  maxTasks: number
  maxBytes?: number
}

export class SerialQueue {
  private readonly waiting: Array<{
    task: () => Promise<void>
    cost: number
  }> = []
  private draining = false
  private closed = false
  private tasks = 0
  private bytes = 0

  constructor(private readonly limits: SerialQueueLimits) {}

  get pendingTasks(): number {
    return this.tasks
  }

  get pendingBytes(): number {
    return this.bytes
  }

  push(task: () => Promise<void>, cost = 0): void {
    if (this.closed) throw new Error('LX serial queue is closed')
    if (this.tasks >= this.limits.maxTasks)
      throw new QueueOverflowError('tasks', this.limits.maxTasks)
    if (
      this.limits.maxBytes !== undefined &&
      this.bytes + cost > this.limits.maxBytes
    )
      throw new QueueOverflowError('bytes', this.limits.maxBytes)

    this.tasks += 1
    this.bytes += cost
    this.waiting.push({ task, cost })
    if (!this.draining) {
      this.draining = true
      queueMicrotask(() => void this.drain())
    }
  }

  close(): void {
    this.closed = true
    for (const entry of this.waiting) {
      this.tasks -= 1
      this.bytes -= entry.cost
    }
    this.waiting.length = 0
  }

  private async drain(): Promise<void> {
    let entry = this.waiting.shift()
    while (entry) {
      try {
        await entry.task()
      } catch {
        // The task owns error reporting; a rejection must still release capacity.
      } finally {
        this.tasks -= 1
        this.bytes -= entry.cost
      }
      entry = this.waiting.shift()
    }
    this.draining = false
  }
}
