// Agentix — in-process event bus -> SSE fan-out
// History lives in the store; SSE handlers replay from there before subscribing.
import type { AgentEvent } from '../../shared/src/types.ts';

type Subscriber = (event: AgentEvent) => void;

export class EventBus {
  private subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  publish(event: AgentEvent): void {
    for (const sub of this.subscribers) {
      try { sub(event); } catch { /* ignore dead subscribers */ }
    }
  }
}
