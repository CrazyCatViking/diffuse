import type { AttentionNavigationRequest } from './attentionPresentation';

type NavigationTarget = {
  send(channel: string, request: AttentionNavigationRequest): void;
};

export class WorkbenchNavigationQueue {
  private readonly pending: AttentionNavigationRequest[] = [];
  private readyTarget: NavigationTarget | null = null;

  constructor(private readonly limit = 64) {}

  enqueue(request: AttentionNavigationRequest, target: NavigationTarget): void {
    if (this.readyTarget === target) {
      target.send('attention:navigate', request);
      return;
    }
    if (this.pending.some((item) => item.attentionId === request.attentionId && item.revision === request.revision)) return;
    this.pending.push(request);
    if (this.pending.length > this.limit) this.pending.splice(0, this.pending.length - this.limit);
  }

  markReady(target: NavigationTarget): void {
    this.readyTarget = target;
    const pending = this.pending.splice(0);
    for (const request of pending) target.send('attention:navigate', request);
  }

  markNotReady(target?: NavigationTarget): void {
    if (!target || this.readyTarget === target) this.readyTarget = null;
  }
}
