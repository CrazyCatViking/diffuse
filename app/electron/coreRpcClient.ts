import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class CoreRequestTimeoutError extends Error {
  constructor(method: string) {
    super(`Core request timed out: ${method}`)
    this.name = 'CoreRequestTimeoutError'
  }
}

export class CoreRpcClient extends EventEmitter {
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private exited = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super()

    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => this.handleLine(line))

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) console.error(`[diffuse-core] ${text}`)
    })

    child.on('error', (error) => {
      this.rejectAll(error)
    })

    child.on('exit', (code, signal) => {
      this.exited = true
      const error = new Error(`Diffuse core exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`)
      this.rejectAll(error)
      this.emit('exit', { code, signal })
    })
  }

  get isRunning(): boolean {
    return (
      !this.exited &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.child.stdin.destroyed
    )
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.exited = true
        this.child.kill()
        reject(new CoreRequestTimeoutError(method))
      }, 30_000)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

      if (!this.isRunning) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('Diffuse core is not running'))
        return
      }

      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  dispose(): void {
    this.exited = true
    this.child.kill()
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return

    let message: any
    try {
      message = JSON.parse(line)
    } catch (error) {
      console.error('Invalid core JSON-RPC line', line, error)
      return
    }

    if (typeof message.id !== 'number') {
      this.emit('event', message)
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'Core request failed'))
    } else {
      pending.resolve(message.result)
    }
  }
}
