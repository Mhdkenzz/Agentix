// Agentix — in-process event bus -> SSE fan-out
import type { AgentEvent } from '../../shared/src/types.ts';

type Subscriber = (event: AgentEvent) => void;

export class EventBus {
  private subscribers = new Set<Subscriber>();
  private eventHistory: AgentEvent[] = [];
  private maxHistory = 5000;

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    // Send recent history to new subscriber
    const recent = this.eventHistory.slice(-100);
    for (const e of recent) {
      fn(e);
    }
    return () => { this.subscribers.delete(fn); };
  }

  publish(event: AgentEvent): void {
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory = this.eventHistory.slice(-this.maxHistory);
    }
    for (const sub of this.subscribers) {
      try { sub(event); } catch { /* ignore dead subscribers */ }
    }
  }

  getHistory(after?: number): AgentEvent[] {
    if (after === undefined) return [...this.eventHistory];
    return this.eventHistory.filter(e => e.id > after);
  }

  getLastEventId(): number {
    return this.eventHistory.length > 0
      ? this.eventHistory[this.eventHistory.length - 1].id
      : 0;
  }
}
