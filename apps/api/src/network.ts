import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { realSleep } from '@paybox/core';
import type { Random } from '@paybox/shared';

/**
 * Network simulation (spec §40, §41).
 *
 * Latency is applied on the *response* rather than the request. That is not an
 * implementation detail — it is what makes spec §41's hardest scenario
 * reachable: with the response held open, the webhook for a payment can arrive
 * at the developer's server *before* the API call that created it returns.
 * Integrations that assume the API response always comes first break here,
 * which is exactly the bug this emulator exists to surface.
 */
export interface NetworkProfile {
  /** Delay added before the response is flushed, in real milliseconds. */
  latencyMs: number;
  /** Fraction of requests answered with an error instead, 0..1. */
  failureRate: number;
  /** Status used when a request is selected to fail. */
  failureStatus: number;
}

export const DEFAULT_NETWORK: NetworkProfile = {
  latencyMs: 0,
  failureRate: 0,
  failureStatus: 500,
};

export class NetworkSimulator {
  #profile: NetworkProfile = { ...DEFAULT_NETWORK };
  readonly #random: Random;

  constructor(random: Random) {
    this.#random = random.fork('network');
  }

  get profile(): NetworkProfile {
    return { ...this.#profile };
  }

  update(patch: Partial<NetworkProfile>): NetworkProfile {
    this.#profile = { ...this.#profile, ...patch };
    return this.profile;
  }

  reset(): NetworkProfile {
    this.#profile = { ...DEFAULT_NETWORK };
    return this.profile;
  }

  shouldFail(): boolean {
    return this.#profile.failureRate > 0 && this.#random.chance(this.#profile.failureRate);
  }
}

export interface NetworkPluginOptions {
  simulator: NetworkSimulator;
  /** Provider-shaped error body, so a simulated failure looks native. */
  errorBody: (status: number) => unknown;
}

const plugin: FastifyPluginAsync<NetworkPluginOptions> = async (fastify, options) => {
  fastify.addHook('onRequest', async (_request, reply) => {
    if (!options.simulator.shouldFail()) return;
    const status = options.simulator.profile.failureStatus;
    // Fail before the handler runs: a provider that 500s at its edge never
    // touched the transaction, and integrations must handle that.
    return reply.status(status).send(options.errorBody(status));
  });

  fastify.addHook('onSend', async (_request, _reply, payload) => {
    const { latencyMs } = options.simulator.profile;
    if (latencyMs > 0) await realSleep(latencyMs);
    return payload;
  });
};

/** See the note on idempotencyPlugin: hooks must escape encapsulation to
 *  reach the provider routes registered beside this plugin. */
export const networkPlugin = fp(plugin, { name: 'paybox-network', fastify: '5.x' });
