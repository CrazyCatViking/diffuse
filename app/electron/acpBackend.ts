import { createAcpApi, type AcpApi, type AcpMethod, type AcpEventBatch } from '../src/lib/acpContract';
import { CoreBackendError } from './coreBackend';

export interface AcpBackend extends AcpApi {}
export class AcpBackend {
  protected readonly acpListeners = new Set<(batch: AcpEventBatch) => void>();
  constructor(
    invoke: (method: AcpMethod, request: unknown) => Promise<unknown> = async (method) => {
      throw new CoreBackendError('UNSUPPORTED_METHOD', `${method} requires the native ACP backend; RPC rollback does not support ACP`);
    },
  ) {
    Object.assign(this, createAcpApi(invoke));
  }
  onAcpEventBatch(listener: (batch: AcpEventBatch) => void): () => void {
    this.acpListeners.add(listener);
    return () => this.acpListeners.delete(listener);
  }
}
