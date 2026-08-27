import type { PayboxEvent } from '@paybox/shared';

export type EventHandler = (event: PayboxEvent) => void | Promise<void>;

/**
 * In-process event bus (spec §8).
 *
 * Subscribers are the webhook dispatcher, the dashboard's SSE stream, and the
 * structured logger. Handler errors are isolated: a webhook dispatcher that
 * throws must not prevent the SSE stream from seeing the event, and must never
 * roll back the state change that produced it.
 *
 * Events reach the bus only *after* the transaction that produced them has
 * committed. See PaymentEngine's outbox handling -- publishing mid-transaction
 * would let a webhook describe a state that then gets rolled back, which is
 * exactly the class of bug this emulator exists to help people find.
 */
export class EventBus {
  readonly #handlers = new Map<string, Set<EventHandler>>();
  #onError: (error: unknown, event: PayboxEvent) => void = () => {};

  on(type: string, handler: EventHandler): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Subscribe to every event. */
  onAny(handler: EventHandler): () => void {
    return this.on('*', handler);
  }

  onError(handler: (error: unknown, event: PayboxEvent) => void): void {
    this.#onError = handler;
  }

  async emit(event: PayboxEvent): Promise<void> {
    const handlers = [
      ...(this.#handlers.get(event.type) ?? []),
      ...(this.#handlers.get('*') ?? []),
    ];
    // Sequential, not Promise.all: ordering across subscribers is observable
    // in the dashboard timeline, and concurrency here buys nothing locally.
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        this.#onError(error, event);
      }
    }
  }

  async emitAll(events: readonly PayboxEvent[]): Promise<void> {
    for (const event of events) await this.emit(event);
  }
}
