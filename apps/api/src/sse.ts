import type { FastifyPluginAsync } from 'fastify';
import type { PayboxContext } from './context.js';

/**
 * Live event stream for the dashboard (spec §23, §49).
 *
 * Server-sent events rather than a WebSocket: the traffic is strictly
 * server-to-client, reconnection is free, and it survives any proxy that
 * handles plain HTTP. A WebSocket would add a protocol and a dependency to buy
 * a bidirectional channel nothing here needs.
 */
export const ssePlugin: FastifyPluginAsync<{ context: PayboxContext }> = async (
  fastify,
  { context },
) => {
  fastify.get('/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Without this, a proxy or the browser may hold the stream in a buffer
      // and the dashboard appears frozen.
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`retry: 2000\n\n`);

    const send = (type: string, data: unknown) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('hello', { time: context.clock.nowISO(), clock: context.clock.state() });

    const unsubscribeEvents = context.bus.onAny((event) => {
      send('event', event);
    });
    const unsubscribeClock = context.clock.onChange((state) => {
      send('clock', state);
    });

    request.raw.on('close', () => {
      unsubscribeEvents();
      unsubscribeClock();
    });
  });
};
