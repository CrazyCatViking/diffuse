import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isCoreEvent } from '../src/lib/coreContract';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class CoreRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CoreRpcError';
  }
}

export class CoreRequestTimeoutError extends Error {
  constructor(method: string) {
    super(`Core request timed out: ${method}`);
    this.name = 'CoreRequestTimeoutError';
  }
}

export class CoreRpcProtocolError extends Error {
  constructor(
    message: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'CoreRpcProtocolError';
  }
}

export class CoreRpcClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private exited = false;
  private exitEmitted = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[diffuse-core] ${text}`);
    });

    child.on('error', (error) => {
      this.finishExit(error, null, null);
    });

    child.on('exit', (code, signal) => {
      const error = new Error(`Diffuse core exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
      this.finishExit(error, code, signal);
    });
  }

  get isRunning(): boolean {
    return (
      !this.exited && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null && !this.child.stdin.destroyed
    );
  }

  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
    options: { killOnTimeout?: boolean } = {},
  ): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const killOnTimeout = options.killOnTimeout ?? true;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new CoreRequestTimeoutError(method);
        if (killOnTimeout) this.dispose(error);
        reject(error);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      if (!this.isRunning) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Diffuse core is not running'));
        return;
      }

      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  dispose(error = new Error('Diffuse core was disposed')): void {
    this.exited = true;
    this.rejectAll(error);
    if (!this.child.killed) this.child.kill();
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private finishExit(error: Error, code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.rejectAll(error);
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.emit('exit', { code, signal });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('protocolError', new CoreRpcProtocolError('Invalid core JSON-RPC line', { line, error }));
      return;
    }

    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      this.emit('protocolError', new CoreRpcProtocolError('Invalid core JSON-RPC message', message));
      return;
    }

    if (!('id' in message)) {
      if (isCoreEvent(message)) this.emit('event', message);
      else this.emit('protocolError', new CoreRpcProtocolError('Invalid core notification', message));
      return;
    }

    if (message.id === null) {
      const error = parseRpcError(message.error);
      if (error) this.emit('rpcError', error);
      else this.emit('protocolError', new CoreRpcProtocolError('Invalid null-id core error', message));
      return;
    }

    if (typeof message.id !== 'number') {
      this.emit('protocolError', new CoreRpcProtocolError('Invalid core response id', message));
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if ('error' in message) {
      const rpcError = parseRpcError(message.error);
      pending.reject(rpcError ?? new CoreRpcProtocolError('Invalid core error response', message));
    } else if ('result' in message) {
      pending.resolve(message.result);
    } else {
      pending.reject(new CoreRpcProtocolError('Core response has neither result nor error', message));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRpcError(value: unknown): CoreRpcError | null {
  if (!isRecord(value) || typeof value.code !== 'number' || typeof value.message !== 'string') return null;
  return new CoreRpcError(value.code, value.message, value.data);
}
