/**
 * Starting, stopping and restarting a workspace that already exists.
 *
 * Tier 4. The state machine is `types.STATE_ACTIONS`; `preconditions.checkStateRequest`
 * decides whether the move is allowed, and this module makes it.
 */
import * as config from '../../lib/config';
import { DockerError, ValidationError } from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { pathExists, valueKind } from '../../lib/format';
import { joinPath } from '../../lib/home';
import { detach } from '../edge/networks';
import { namespaceFor, requireOwnNamespace } from '../kube/namespace';
import { CONTEXT as KUBE_CONTEXT } from '../kube/names';
import { startWorkspace, stopWorkspace } from '../kube/scale';
import * as engine from '../runner/engine';
import { reproLock, updateConfig } from '../runner/locks';
import * as paths from '../runner/paths';
import { readMeta, updateMeta } from '../runner/record';
import { containerDetails, networklessContainers, rcState, startErrors } from '../runner/queries';
import * as topology from '../topology';

import * as naming from './naming';
import { stopPortForward } from './ready';
import { INTERACTIVE_LOCK_WAIT, STATE_ACTIONS } from './types';

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export async function clearDefaultIf(name: string): Promise<void> {
  // Locked read-modify-write: `prune` calls this in a loop and the GUI runs it on worker
  // threads, so a plain read/write pair can lose an update.
  await updateConfig((cfg) => {
    if (cfg.default_repro === name) delete cfg.default_repro;
  });
}

/** Whether a Kubernetes record has a compose file beside it: see `downComposeLeftovers`. */
export function hasComposeLeftovers(name: string): boolean {
  return pathExists(joinPath(paths.workspace(name), 'docker-compose.yml'));
}

/**
 * Docker containers left under a Kubernetes record, brought down before the record goes.
 *
 * 2.1.1's Kubernetes create took a Docker workspace of the same name for its own: it rewrote
 * the record and left the compose file and the containers running. Tearing the Kubernetes side
 * down then removed the compose file, the one thing naming that project, so nothing could find
 * the containers or their data volume again -- and a later Docker `up` of the name started on
 * that old data. A Kubernetes workspace writes no compose file, so one there is a leftover.
 */
export async function downComposeLeftovers(
  name: string,
  volumes: boolean,
  emit: Emit,
): Promise<void> {
  if (!hasComposeLeftovers(name)) return;
  info(
    emit,
    `'${name}' still has Docker containers from before it ran on Kubernetes — removing them first`,
    {
      phase: 'teardown',
    },
  );
  const failed = new DockerError(
    `could not remove the Docker containers left under '${name}', so nothing else was ` +
      `removed — \`docker compose -p ${paths.mintProjectName(name)} down${volumes ? ' -v' : ''}\` ` +
      'removes them',
  );
  // As a Compose teardown goes: stopped while the edge is attached, detached, then down.
  if ((await engine.stop(name)) !== 0) throw failed;
  await detach(name);
  if ((await engine.down(name, { volumes })) !== 0) throw failed;
}

/**
 * stop/start/restart by scaling, which is the nearest true thing Kubernetes has.
 *
 * Compose's contract is what this has to match, not Kubernetes' vocabulary: `stop` gives
 * the memory back and keeps the data, `start` brings the same workspace back on the same
 * port. Scaling to 0 does exactly that -- the PersistentVolumeClaim is untouched.
 *
 * The port-forward is a real difference and is handled rather than ignored: it dies with
 * the pod, so `stop` kills it deliberately and `start` hands back to `ready`, which
 * re-establishes it.
 */
export async function setStateKubernetes(
  target: string,
  action: string,
  emit: Emit = nullEmit,
): Promise<void> {
  const meta = await readMeta(target);
  const extra = bag(meta.extra);
  const context = isTruthy(extra[config.EXTRA_CONTEXT])
    ? String(extra[config.EXTRA_CONTEXT])
    : KUBE_CONTEXT;
  await reproLock(
    target,
    async () => {
      await requireOwnNamespace(target, { context });
      if (action === 'stop' || action === 'restart') {
        await stopWorkspace(target, { context, version: meta.rcVersion, emit });
        const pid = extra.port_forward_pid;
        if (isTruthy(pid)) {
          await stopPortForward(Number(pid), { namespace: await namespaceFor(target) });
          await updateMeta(target, (current) => {
            delete current.extra.port_forward_pid;
          });
        }
        // A preset's UI forwards die with their pods the same way, but their process can
        // outlive the pod -- and `ready` judges a forward by its process, so after a start
        // the stale Keycloak forward read as alive, was never repaired, and SAML sign-in
        // failed. Stopped here and LEFT RECORDED, so `ready` finds them dead and re-forwards.
        for (const uiPid of Object.values(bag(extra.scenario_forwards))) {
          await stopPortForward(Number(uiPid), { namespace: await namespaceFor(target) });
        }
      }
      if (action === 'start' || action === 'restart') {
        await startWorkspace(target, { context, version: meta.rcVersion, emit });
        // NO PORT-FORWARD HERE, and that is the tested answer rather than the obvious one.
        // Scaling up from zero takes far longer than `portForward`'s brief pod wait, so
        // kubectl attaches to a pod that is not ready, binds the socket for a moment and
        // exits. Only `ready` waits for the pod before forwarding, so only `ready` can
        // honestly restore the URL. What was missing was not the forward: it was SAYING so.
        warn(
          emit,
          `'${target}' is scaling back up. Its URL is a port-forward that ` +
            'died with the old pod, and a new one can only be attached ' +
            'once the pod is ready — `houston ready --name ' +
            `${target}\` waits for it and re-establishes the forward.`,
          { phase: 'boot' },
        );
      }
    },
    { timeoutMs: INTERACTIVE_LOCK_WAIT * 1000 },
  );
}

/**
 * A START THAT LEFT A CONTAINER WITH NO NETWORK is recreated. An earlier start that failed
 * on a held port detaches it, and every later start "succeeds" over a Rocket.Chat that
 * cannot reach MongoDB and publishes no port; `compose up -d` puts it back as specified.
 */
async function reattachTheNetworkless(target: string, action: string, emit: Emit): Promise<void> {
  if (action !== 'start' && action !== 'restart') return;
  const detached = await networklessContainers(target);
  if (detached.length === 0) return;
  info(
    emit,
    `${detached.join(', ')} came up with no network, left so by an earlier start that ` +
      'failed — recreating it, data kept',
    { phase: 'boot' },
  );
  if ((await engine.up(target, { pull: false })) !== 0) {
    throw new DockerError(
      `could not recreate ${detached.join(', ')} for '${target}', which ` +
        'came up with no network',
    );
  }
}

/** What a `down`ed workspace is told when asked to start: it has nothing to start. */
async function downedHint(target: string): Promise<string> {
  // With its version: `up` requires one.
  const { rcVersion } = await readMeta(target);
  return (
    ` - '${target}' was taken down with \`houston down\`, so there is nothing to start; ` +
    `bring it back, data intact: houston up --version ${rcVersion} --name ${target}`
  );
}

/**
 * Stop/start/restart a workspace. Returns what happened, for a caller that has to decide
 * what to do next.
 *
 * `needs_ready` is the one fact a front-end cannot work out for itself: on Kubernetes a
 * `start` scales the deployment back up and CANNOT re-establish the port-forward that
 * died with the old pod. The GUI used to infer that from "did this emit anything", which
 * is a proxy for the real question and would answer wrongly the moment any other warning
 * was added.
 */
export async function setState(
  name: string,
  action: unknown,
  emit: Emit = nullEmit,
  { streamOutput = false } = {},
): Promise<Record<string, unknown>> {
  const target = await naming.resolveName(name);
  // Guarded here rather than in each front-end: the CLI's `stop`/`start`/`restart` and
  // the GUI's always-enabled buttons both arrive through this one function, so one guard
  // covers both and cannot drift between them.
  //
  // Looked up by a string key: `action` arrives from a JSON body, and an object or list
  // reached the lookup and failed as "unhashable type" -- a 500 rather than the "unknown
  // action" this already knows how to say. Validated BEFORE the runtime split so a bad
  // action is rejected the same way on both.
  if (typeof action !== 'string') {
    throw new ValidationError(
      `action must be a string (want start|stop|restart), got ` + valueKind(action),
    );
  }
  if (!STATE_ACTIONS.includes(action)) {
    throw new ValidationError(`unknown action '${action}' (want start|stop|restart)`);
  }
  // SAID BEFORE THE WAIT, on both runtimes: every service (or pod) closes cleanly first, and
  // nothing was said until it had, so the GUI's job dialog sat empty and read as hung, on any
  // workspace (12 s on a voice lab, FreeSWITCH 9 of them). On Docker a GUI job also gets
  // docker's own lines below; the terminal keeps docker's output.
  const phase = action === 'stop' ? 'teardown' : 'boot';
  info(
    emit,
    action === 'stop'
      ? `stopping '${target}': each service closes cleanly first, which can take several seconds`
      : `${action === 'start' ? 'starting' : 'restarting'} '${target}'`,
    { phase },
  );
  if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
    await setStateKubernetes(target, action, emit);
    return {
      name: target,
      action,
      runtime: topology.KUBERNETES,
      needs_ready: action === 'start' || action === 'restart',
    };
  }
  // A `down`ed workspace has no containers, and `compose restart` restarts the ones there
  // are: none, exit 0, and the CLI said "restarted". `start` already refused this.
  if (action === 'restart' && (await containerDetails(target)).length === 0) {
    throw new DockerError(
      `\`docker compose restart\` failed for '${target}'${await downedHint(target)}`,
    );
  }
  const fn = action === 'start' ? engine.start : action === 'stop' ? engine.stop : engine.restart;
  const echo = streamOutput
    ? [(line: string): void => info(emit, line, { phase, data: { echo: 'docker' } })]
    : [];
  // Locked like every other mutator. Stop/Restart are always-enabled GUI buttons, so they
  // were clickable straight through a create, backup or upgrade running on the same repro
  // -- and the GUI's pending map only blocks within ONE tab. The network repair is held
  // too: it recreates containers, and ran after the lock was let go.
  const rc = await reproLock(
    target,
    async () => {
      const code = await fn(target, ...echo);
      if (code === 0) await reattachTheNetworkless(target, action, emit);
      return code;
    },
    { timeoutMs: INTERACTIVE_LOCK_WAIT * 1000 },
  );
  if (rc !== 0) {
    // A `down`ed repro has no containers, so `compose start` can never revive it. Say
    // what actually works instead of the exit code. Asked with `ps --all`: `rcState` reads
    // `compose ps` WITHOUT it, so a merely STOPPED repro read as absent, and every failed
    // start of one was told it had been `down`ed -- pointing away from compose's real error.
    let hint = '';
    if (
      (action === 'start' || action === 'restart') &&
      (await containerDetails(target)).length === 0
    ) {
      hint = await downedHint(target);
    } else if (action !== 'stop') {
      // Why, from Docker: compose said it on a stream only the CLI's terminal saw.
      const why = await startErrors(target);
      if (why.length > 0) hint = ` — ${why.join('; ')}`;
    }
    throw new DockerError(`\`docker compose ${action}\` failed for '${target}'${hint}`);
  }
  // NOR IS A RESTART THAT LEFT ROCKET.CHAT STOPPED a restart. After a start that could not
  // bind its port, the containers sit created-not-running, `compose restart` answers 0 and
  // starts nothing, and the CLI printed "restarted" over a workspace serving nothing.
  if (action === 'restart' && (await rcState(target)) !== 'running') {
    throw new DockerError(
      `\`docker compose restart\` left Rocket.Chat not running in '${target}' — ` +
        `\`houston logs --name ${target}\` says why, and \`houston start --name ${target}\` ` +
        "shows compose's own error",
    );
  }
  // Compose keeps its published port across a stop/start, so nothing has to be
  // re-attached and there is nothing further for the caller to do.
  return { name: target, action, runtime: topology.DOCKER, needs_ready: false };
}
