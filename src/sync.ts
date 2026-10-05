// 同步队列：断网操作留队列，回网按原操作号重试，已送达的操作不重复写签字或意见
import { LiftServer, OpResult } from './server';
import { Op } from './domain';

export type OutboxStatus = 'pending' | 'failed' | 'synced' | 'parked';

export type OutboxEntry = Op & {
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  results?: OpResult[];
};

type Listener = () => void;

export class SyncQueue {
  outbox: OutboxEntry[] = [];
  online = true;
  // 演示用：注入一次网络失败，验证失败留队列、按原号重试
  failNextFlush = false;
  private server: LiftServer;
  private listeners = new Set<Listener>();

  constructor(server: LiftServer) {
    this.server = server;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  enqueue(op: Op): void {
    this.outbox.push({ ...op, status: 'pending', attempts: 0 });
    this.notify();
  }

  // 回网后按队列顺序逐条送达；失败则保留原操作号，待重试
  async flush(): Promise<void> {
    if (!this.online) return;
    const pending = this.outbox.filter((e) => e.status === 'pending' || e.status === 'failed');
    if (pending.length === 0) return;

    for (const entry of pending) {
      entry.attempts += 1;
      try {
        if (this.failNextFlush) {
          this.failNextFlush = false;
          throw new Error('网络抖动：操作未送达服务器');
        }
        const results = this.server.applyOps([entry]);
        entry.results = results;
        const r = results[0];
        if (r.status === 'duplicate') {
          // 已送达过，按原操作号去重，不重复写签字或意见
          entry.status = 'synced';
        } else if (r.status === 'parked') {
          entry.status = 'parked';
        } else {
          entry.status = 'synced';
        }
      } catch (e) {
        entry.status = 'failed';
        entry.lastError = (e as Error).message;
        this.notify();
        return; // 失败即停，后续操作留在队列
      }
    }
    this.notify();
  }

  retry(opId: string): void {
    const entry = this.outbox.find((e) => e.opId === opId);
    if (entry && entry.status === 'failed') {
      entry.status = 'pending';
      entry.lastError = undefined;
    }
    void this.flush();
  }

  retryAll(): void {
    for (const entry of this.outbox) {
      if (entry.status === 'failed') {
        entry.status = 'pending';
        entry.lastError = undefined;
      }
    }
    void this.flush();
  }

  removeProcessed(): void {
    this.outbox = this.outbox.filter((e) => e.status !== 'synced' && e.status !== 'parked');
    this.notify();
  }

  pendingCount(): number {
    return this.outbox.filter((e) => e.status === 'pending' || e.status === 'failed').length;
  }

  failedCount(): number {
    return this.outbox.filter((e) => e.status === 'failed').length;
  }
}
