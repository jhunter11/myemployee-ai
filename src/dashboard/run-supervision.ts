/**
 * Supervisor attribution for agent runs.
 *
 * SPEC §20 is explicit that containment grants no authority and that delegation
 * is never transitively inherited, so a supervisor is only ever read from an
 * edge the run itself carries. Exactly two edges qualify:
 *
 * 1. `parentRunId` — a run that was delegated by another run. The delegating
 *    run is the supervisor. This is a real recorded edge, not an inference.
 * 2. `clientId` — a root run bound to a client/agency sleeve. The supervising
 *    profile is that sleeve's manager.
 *
 * A root run with no client binding falls to Jarvis, the coordinating profile
 * over the personal sleeve. Nothing here walks a scope tree upward: if an edge
 * is absent we report the root coordinator rather than guessing an ancestor.
 *
 * Known gap, deliberately not papered over: `Supervisor.run` is the only writer
 * of `agent_runs` and passes `parentRunId: null` unconditionally, so on live
 * data the `delegating_run` branch never fires and every run attributes to a
 * sleeve manager or to Jarvis. Real delegation parentage is currently recorded
 * in the separate `delegation_runs` table, which carries its own scope and
 * tenant binding and is therefore not safe to join in blind. Until one of those
 * two is closed, a `delegating_run` chip only appears for seeded rows — which is
 * why every chip reports the edge it came from rather than asserting a hierarchy.
 */

/** The reserved client id used by runs that belong to no tenant sleeve. */
export const SYSTEM_SLEEVE_ID = 'system';

/** The root coordinating profile. Not a sleeve manager — the operator's own agent. */
export const JARVIS_SUPERVISOR_ID = 'jarvis';

export type SupervisorKind = 'jarvis' | 'sleeve_manager' | 'delegating_run';

export interface RunSupervisor {
  kind: SupervisorKind;
  /** Stable identifier: an agent id, a `sleeve:<id>` handle, or a run id. */
  id: string;
  label: string;
  /** The sleeve the run is accountable to, for P&L and grouping. */
  sleeveId: string;
  /** Which recorded edge produced this attribution, for operator inspection. */
  derivedFrom: 'parent_run_id' | 'client_id' | 'root_default';
}

export interface SupervisedRunInput {
  id: string;
  clientId: string;
  automation: string;
  parentRunId: string | null;
  /** The delegating run's automation, resolved by the caller's self-join. */
  parentAutomation: string | null;
}

function humanizeAutomation(automation: string): string {
  const normalized = automation.replace(/[-_]+/g, ' ').trim();
  return normalized.length === 0 ? 'Unnamed automation' : normalized;
}

function isTenantSleeve(clientId: string): boolean {
  const normalized = clientId.trim();
  return normalized.length > 0 && normalized !== SYSTEM_SLEEVE_ID;
}

/**
 * Resolve the sleeve a run is accountable to. Runs with no tenant binding roll
 * up to the system sleeve rather than being dropped from P&L entirely.
 */
export function sleeveForRun(clientId: string): string {
  return isTenantSleeve(clientId) ? clientId.trim() : SYSTEM_SLEEVE_ID;
}

export function deriveRunSupervisor(run: SupervisedRunInput): RunSupervisor {
  const sleeveId = sleeveForRun(run.clientId);

  // A recorded delegation edge always wins: the run that spawned this one is
  // its supervisor regardless of which sleeve either sits in.
  if (run.parentRunId !== null && run.parentRunId.trim().length > 0) {
    const parentLabel =
      run.parentAutomation === null || run.parentAutomation.trim().length === 0
        ? `Run ${run.parentRunId}`
        : humanizeAutomation(run.parentAutomation);
    return {
      kind: 'delegating_run',
      id: run.parentRunId,
      label: parentLabel,
      sleeveId,
      derivedFrom: 'parent_run_id'
    };
  }

  // A root run inside a tenant sleeve is supervised by that sleeve's manager.
  if (isTenantSleeve(run.clientId)) {
    return {
      kind: 'sleeve_manager',
      id: `sleeve:${sleeveId}`,
      label: `${sleeveId} sleeve manager`,
      sleeveId,
      derivedFrom: 'client_id'
    };
  }

  return {
    kind: 'jarvis',
    id: JARVIS_SUPERVISOR_ID,
    label: 'Jarvis',
    sleeveId,
    derivedFrom: 'root_default'
  };
}
