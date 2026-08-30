import { parse as parseYaml } from 'yaml';
import {
  PAYMENT_STATUSES,
  PayboxError,
  type Clock,
  type IdFactory,
  type PaymentStatus,
} from '@paybox/shared';
import {
  canTransitionPayment,
  isTerminalPayment,
  parseDuration,
  type Job,
  type JobResult,
  type PaymentEngine,
  type Storage,
} from '@paybox/core';
import type { PaymentSimulator } from './simulator.js';
import { SIMULATED_OUTCOMES, type SimulatedOutcome } from './instruments.js';

export const SCENARIO_STEP_JOB = 'scenario.step';

const SCENARIO_ACTIONS = ['cancel', 'expire', 'authorize', 'capture', 'approve', 'reject'] as const;

/**
 * Statuses in which the money has been collected. Not terminal -- a refund
 * can still follow -- but no outcome or action step has anything left to do.
 */
const SETTLED: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  'successful',
  'partially_refunded',
  'refunded',
]);

/**
 * A scenario step (spec §12). Exactly one of `status`, `outcome` or `action`
 * describes what the step does; `delay` is how long after the previous step it
 * runs, on virtual time.
 */
export interface ScenarioStep {
  delay?: string | number;
  status?: PaymentStatus;
  outcome?: SimulatedOutcome;
  action?: 'cancel' | 'expire' | 'authorize' | 'capture' | 'approve' | 'reject';
  /** Free-text note surfaced in the timeline. */
  note?: string;
}

export interface Scenario {
  name: string;
  description?: string;
  steps: ScenarioStep[];
}

export interface ScenarioRun {
  id: string;
  scenario: string;
  paymentId: string;
  steps: number;
  startedAt: string;
  /** When the last step is scheduled to fire, on virtual time. */
  completesAt: string;
}

/**
 * Built-in scenarios. These are the flows that are tedious to reproduce by
 * hand and that most integrations get wrong, which is the whole point of
 * shipping them rather than leaving every developer to write their own.
 */
export const BUILT_IN_SCENARIOS: readonly Scenario[] = [
  {
    name: 'mobile-money-success',
    description: 'Prompt, customer approves after a pause, payment succeeds.',
    steps: [
      { status: 'pending' },
      { delay: '2s', status: 'requires_action', note: 'Awaiting customer authorization' },
      { delay: '5s', outcome: 'success' },
    ],
  },
  {
    name: 'mobile-money-timeout',
    description: 'Prompt is never answered and the payment expires.',
    steps: [
      { status: 'pending' },
      { delay: '2s', status: 'requires_action' },
      { delay: '5m', action: 'expire' },
    ],
  },
  {
    name: 'mobile-money-rejected',
    description: 'Customer actively declines the prompt on their handset.',
    steps: [
      { status: 'pending' },
      { delay: '2s', status: 'requires_action' },
      { delay: '4s', action: 'reject' },
    ],
  },
  {
    name: 'card-insufficient-funds',
    description: 'Card is accepted, then declined for funds during authorization.',
    steps: [
      { status: 'pending' },
      { delay: '1s', outcome: 'insufficient_funds' },
    ],
  },
  {
    name: 'card-3ds-success',
    description: '3-D Secure step-up, then a successful authorization.',
    steps: [
      { status: 'pending' },
      { delay: '1s', outcome: 'authentication_required' },
      { delay: '6s', action: 'approve' },
    ],
  },
  {
    name: 'slow-success',
    description: 'A payment that sits in processing for 30 seconds before settling.',
    steps: [
      { status: 'pending' },
      { delay: '3s', status: 'processing' },
      { delay: '30s', outcome: 'success' },
    ],
  },
  {
    name: 'late-reversal',
    description:
      'Payment fails, then the provider reverses itself and reports success — the case most integrations mishandle.',
    steps: [
      { status: 'pending' },
      { delay: '2s', outcome: 'declined' },
      { delay: '2m', status: 'successful', note: 'Provider reversal' },
    ],
  },
];

/**
 * Runs scenarios by scheduling each step as a job on virtual time.
 *
 * Steps are jobs rather than an in-process loop so that a scenario survives a
 * restart, shows up in the jobs table, and -- critically -- fast-forwards under
 * `paybox time advance`. A 72-hour scenario runs in a millisecond.
 */
export class ScenarioRunner {
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #simulator: PaymentSimulator;
  readonly #engine: PaymentEngine;
  readonly #scenarios = new Map<string, Scenario>();

  constructor(deps: {
    storage: Storage;
    clock: Clock;
    ids: IdFactory;
    simulator: PaymentSimulator;
    engine: PaymentEngine;
    scenarios?: readonly Scenario[];
  }) {
    this.#storage = deps.storage;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#simulator = deps.simulator;
    this.#engine = deps.engine;
    for (const scenario of deps.scenarios ?? BUILT_IN_SCENARIOS) this.register(scenario);
  }

  register(scenario: Scenario): void {
    validateScenario(scenario);
    this.#scenarios.set(scenario.name, scenario);
  }

  registerFromYaml(source: string): Scenario {
    const parsed: unknown = parseYaml(source);
    const scenario = parsed as Scenario;
    validateScenario(scenario);
    this.#scenarios.set(scenario.name, scenario);
    return scenario;
  }

  list(): Scenario[] {
    return [...this.#scenarios.values()];
  }

  get(name: string): Scenario | null {
    return this.#scenarios.get(name) ?? null;
  }

  async run(name: string, paymentId: string): Promise<ScenarioRun> {
    const scenario = this.#scenarios.get(name);
    if (!scenario) {
      throw new PayboxError('not_found', `No scenario named "${name}".`, {
        details: { available: [...this.#scenarios.keys()] },
      });
    }
    const payment = await this.#engine.getPayment(paymentId);
    if (!payment) throw new PayboxError('not_found', `No payment with id ${paymentId}.`);

    const runId = this.#ids.next('run');
    const startedAt = this.#clock.now();
    let offset = 0;

    for (const [index, step] of scenario.steps.entries()) {
      offset += step.delay ? parseDuration(step.delay) : 0;
      await this.#storage.jobs.enqueue({
        id: this.#ids.next('job'),
        kind: SCENARIO_STEP_JOB,
        payload: { runId, scenario: name, paymentId, index, step: step as never },
        status: 'ready',
        runAt: new Date(startedAt + offset).toISOString(),
        attempt: 0,
        maxAttempts: 1,
        leaseExpiresAt: null,
        lastError: null,
        // The run's own group, deliberately not `payment:<id>`: the engine
        // cancels that group when a payment goes terminal, which used to
        // cancel a scenario's own later steps -- `late-reversal` declined a
        // payment and then never got to reverse it. Steps that land on a
        // settled payment are skipped in `handleJob` instead.
        groupKey: `scenario:${runId}`,
        createdAt: this.#clock.nowISO(),
        updatedAt: this.#clock.nowISO(),
      });
    }

    return {
      id: runId,
      scenario: name,
      paymentId,
      steps: scenario.steps.length,
      startedAt: new Date(startedAt).toISOString(),
      completesAt: new Date(startedAt + offset).toISOString(),
    };
  }

  /** Scheduler handler for `scenario.step`. */
  handleJob = async (job: Job): Promise<JobResult> => {
    const paymentId = String(job.payload.paymentId ?? '');
    const step = job.payload.step as ScenarioStep | undefined;
    if (!paymentId || !step) return;

    // A scenario step that lands on a payment that has already settled is not
    // an error -- the developer may have intervened from the dashboard, or an
    // earlier step may have finished the payment. Skip it.
    const payment = await this.#engine.getPayment(paymentId);
    if (!payment) return;

    if (step.status) {
      if (payment.status === step.status) return;
      // A status step may move a *terminal* payment: that is the explicitly
      // simulated provider reversal `late-reversal` exists for. A settled
      // payment that is not terminal (successful, refunded) has no such
      // escape hatch, so the step is skipped rather than failed.
      if (!canTransitionPayment(payment.status, step.status) && !isTerminalPayment(payment.status)) {
        return;
      }
      await this.#engine.transitionPayment(paymentId, step.status, {
        reversal: true,
        eventData: { scenario: job.payload.scenario, note: step.note ?? null },
      });
      return;
    }

    // Outcomes and actions need a payment that is still in flight.
    if (isTerminalPayment(payment.status) || SETTLED.has(payment.status)) return;

    try {
      if (step.outcome) {
        await this.#simulator.apply(paymentId, step.outcome);
        return;
      }
      switch (step.action) {
        case 'cancel':
          await this.#simulator.cancel(paymentId);
          return;
        case 'expire':
          await this.#simulator.expire(paymentId);
          return;
        case 'authorize':
          await this.#simulator.authorize(paymentId);
          return;
        case 'capture':
          await this.#simulator.capture(paymentId);
          return;
        case 'approve':
          await this.#simulator.completeAuthentication(paymentId, true);
          return;
        case 'reject':
          await this.#simulator.completeAuthentication(paymentId, false);
          return;
        default:
          return;
      }
    } catch (error) {
      // The payment moved between the check above and the transition -- a
      // concurrent settle from the control API, say. Still a skip, not a
      // failed job.
      if (error instanceof PayboxError && error.code === 'invalid_state_transition') return;
      throw error;
    }
  };
}

function validateScenario(scenario: Scenario): void {
  if (!scenario || typeof scenario.name !== 'string' || !scenario.name.trim()) {
    throw new PayboxError('validation_failed', 'A scenario needs a name.');
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    throw new PayboxError('validation_failed', `Scenario "${scenario.name}" has no steps.`);
  }
  for (const [index, step] of scenario.steps.entries()) {
    if (!step.status && !step.outcome && !step.action) {
      throw new PayboxError(
        'validation_failed',
        `Step ${index + 1} of "${scenario.name}" must set one of status, outcome or action.`,
      );
    }
    // The values are checked here, at registration, because a step that
    // cannot apply is *skipped* at run time -- so a misspelt status would
    // otherwise do nothing, silently, on every run.
    const unknown = (kind: string, value: string, allowed: readonly string[]) =>
      new PayboxError(
        'validation_failed',
        `Step ${index + 1} of "${scenario.name}" has an unknown ${kind} "${value}". ` +
          `Allowed: ${allowed.join(', ')}.`,
        { details: { step: index + 1, [kind]: value, allowed } },
      );
    if (step.status !== undefined && !(PAYMENT_STATUSES as readonly string[]).includes(step.status)) {
      throw unknown('status', String(step.status), PAYMENT_STATUSES);
    }
    if (step.outcome !== undefined && !(SIMULATED_OUTCOMES as readonly string[]).includes(step.outcome)) {
      throw unknown('outcome', String(step.outcome), SIMULATED_OUTCOMES);
    }
    if (step.action !== undefined && !(SCENARIO_ACTIONS as readonly string[]).includes(step.action)) {
      throw unknown('action', String(step.action), SCENARIO_ACTIONS);
    }
    if (step.delay !== undefined) parseDuration(step.delay);
  }
}
