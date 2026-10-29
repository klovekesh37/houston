import * as fs from 'node:fs/promises';

import * as config from '../../../src/lib/config';
import { type Emit } from '../../../src/lib/events';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import * as paths from '../../../src/core/runner/paths';

import type * as DestroyNS from '../../../src/core/lifecycle/destroy';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as JournalNS from '../../../src/core/journal';
import type * as HandlersNS from '../../../src/cli/handlers';

it('Grafana public URL regression: destroying a TLS workspace removes its shared-namespace resources', async () => {
  jest.resetModules();
  const removeIngress = jest.fn(async () => undefined);
  jest.doMock('../../../src/core/kube/monitoring', () => ({
    ...jest.requireActual<object>('../../../src/core/kube/monitoring'),
    removeGrafanaIngress: removeIngress,
    removeMonitoring: async () => false,
  }));
  jest.doMock('../../../src/core/kube/operator', () => ({
    ...jest.requireActual<object>('../../../src/core/kube/operator'),
    removeOperator: async () => false,
  }));
  const destroy = require('../../../src/core/lifecycle/destroy') as typeof DestroyNS;
  try {
    await destroy.removeTheClusterSide(
      'prod',
      () => undefined,
      metadata({ name: 'w', extra: { tls: 'local' } }),
      'w',
      true,
    );
    expect(removeIngress).toHaveBeenCalledWith('w', expect.objectContaining({ context: 'prod' }));
  } finally {
    jest.dontMock('../../../src/core/kube/monitoring');
    jest.dontMock('../../../src/core/kube/operator');
    jest.resetModules();
  }
});

it('removes the record of a TLS workspace whose cluster can no longer be asked about its route', async () => {
  // Its namespace was proved gone with the deleted cluster, then the Grafana route's removal
  // raised "could not ask", and the record could never be removed by `down` or `prune`.
  jest.resetModules();
  jest.doMock('../../../src/core/kube/monitoring', () => ({
    ...jest.requireActual<object>('../../../src/core/kube/monitoring'),
    removeGrafanaIngress: async () => {
      throw new Error("could not ask cluster 'gone' about its ingresses");
    },
    removeMonitoring: async () => false,
  }));
  jest.doMock('../../../src/core/kube/operator', () => ({
    ...jest.requireActual<object>('../../../src/core/kube/operator'),
    removeOperator: async () => false,
  }));
  const destroy = require('../../../src/core/lifecycle/destroy') as typeof DestroyNS;
  const record = require('../../../src/core/runner/record') as typeof RecordNS;
  const workspacePaths = require('../../../src/core/runner/paths') as typeof paths;
  try {
    await record.writeRecord(
      'tlsgone',
      record.metadata({ name: 'tlsgone', extra: { tls: 'local' } }),
    );
    const said: string[] = [];
    await destroy.removeTheClusterSide(
      'gone',
      ((event: { message: string }) => said.push(event.message)) as Emit,
      record.metadata({ name: 'tlsgone', extra: { tls: 'local' } }),
      'tlsgone',
      true,
    );
    expect(await workspacePaths.exists('tlsgone')).toBe(false);
    expect(said.join(' ')).toContain("could not remove 'tlsgone''s Grafana route");
  } finally {
    jest.dontMock('../../../src/core/kube/monitoring');
    jest.dontMock('../../../src/core/kube/operator');
    jest.resetModules();
  }
});

it('says so when a Compose teardown removed the data but could not remove the record', async () => {
  // Swallowed: `down --volumes` reported "removed" while `list` went on showing a workspace
  // with nothing behind it. The Kubernetes path already said so.
  jest.resetModules();
  jest.doMock('../../../src/core/runner/engine', () => ({
    ...jest.requireActual<object>('../../../src/core/runner/engine'),
    stop: async () => 0,
    down: async () => 0,
  }));
  jest.doMock('../../../src/core/edge/networks', () => ({
    ...jest.requireActual<object>('../../../src/core/edge/networks'),
    detach: async () => undefined,
  }));
  jest.doMock('../../../src/core/runner/paths', () => ({
    ...jest.requireActual<object>('../../../src/core/runner/paths'),
    remove: async () => undefined, // as a root-owned file inside it would leave it
  }));
  const destroy = require('../../../src/core/lifecycle/destroy') as typeof DestroyNS;
  const record = require('../../../src/core/runner/record') as typeof RecordNS;
  try {
    await record.writeRecord('stuck', record.metadata({ name: 'stuck', project: 'houston-stuck' }));
    const said: string[] = [];
    await destroy.teardownCompose('stuck', true, ((event: { message: string }) =>
      said.push(event.message)) as Emit);
    expect(said.join(' ')).toContain("`list` will still show 'stuck'");
  } finally {
    for (const id of ['runner/engine', 'edge/networks', 'runner/paths']) {
      jest.dontMock(`../../../src/core/${id}`);
    }
    jest.resetModules();
  }
});

it.each([
  [true, 0],
  [false, 1],
])(
  'releases houston-system once: removeMonitoring=%s asks it again %s time(s)',
  async (removed, asked) => {
    // `removeMonitoring` releases the namespace itself when it removed the stack; asking again
    // found it Terminating, and every such teardown said "removed the houston-system
    // namespace" twice.
    jest.resetModules();
    const release = jest.fn(async () => undefined);
    jest.doMock('../../../src/core/kube/monitoring', () => ({
      ...jest.requireActual<object>('../../../src/core/kube/monitoring'),
      removeMonitoring: async () => removed,
      releaseSystemNamespace: release,
    }));
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...jest.requireActual<object>('../../../src/core/kube/operator'),
      removeOperator: async () => false,
    }));
    const destroy = require('../../../src/core/lifecycle/destroy') as typeof DestroyNS;
    try {
      await destroy.removeTheClusterSide(
        'prod',
        () => undefined,
        metadata({ name: 'w' }),
        'w',
        true,
      );
      expect(release).toHaveBeenCalledTimes(asked);
    } finally {
      jest.dontMock('../../../src/core/kube/monitoring');
      jest.dontMock('../../../src/core/kube/operator');
      jest.resetModules();
    }
  },
);

interface Seen {
  message: string;
  level: string;
  phase: string;
}

/**
 * A teardown must finish even when the record cannot be deleted.
 *
 * Earlier releases remove the record ignoring EVERY failure -- a root-owned file a
 * container left behind (EACCES), a file held open (EBUSY), anything. `fs.rm`'s
 * `force: true` forgives only ENOENT, so a rejection made the warning, the default clear
 * and the edge-route drop unreachable: the workspace's namespace is gone, its record
 * cannot be listed as removable, and its route points at nothing -- the exact condition
 * `dropTheEdgeRoute` exists to prevent.
 *
 * The unremovable directory is REAL: a workspace with a file in it, chmod 0555. Unlinking
 * the file then needs write permission on the directory, which is the shape a
 * container-written root-owned file has. Committed as `e5ab0a7`, where both functions
 * reject with EACCES and the warning never runs.
 */
describe('tearing a workspace down when its record will not go', () => {
  afterEach(async () => {
    // A test that fails mid-way leaves the 0555 directory behind, and then the test
    // runner cannot delete its own isolated home. Restore before the runner cleans up.
    for (const name of ['kub', 'cmp']) {
      await fs.chmod(paths.workspace(name), 0o700).catch(() => undefined);
    }
    jest.resetModules();
  });

  async function makeUnremovable(name: string, extra: Record<string, unknown>): Promise<string> {
    await writeRecord(name, metadata({ name, project: `houston-${name}`, extra }));
    const ws = paths.workspace(name);
    // A file inside, so removing the DIRECTORY is not enough: its entries have to be
    // unlinked, which needs write permission on the directory itself.
    await fs.chmod(ws, 0o555);
    return ws;
  }

  async function restore(ws: string): Promise<void> {
    await fs.chmod(ws, 0o700);
    await fs.rm(ws, { recursive: true, force: true });
  }

  async function load(): Promise<typeof DestroyNS> {
    jest.resetModules();
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...jest.requireActual('../../../src/core/kube/operator'),
      removeOperator: async () => false,
    }));
    jest.doMock('../../../src/core/kube/monitoring', () => ({
      ...jest.requireActual('../../../src/core/kube/monitoring'),
      removeMonitoring: async () => false,
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      namespaceFor: async (name: string) => `houston-${name}`,
      deleteNamespace: async () => true,
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach: async () => undefined,
    }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      stop: async () => 0,
      down: async () => 0,
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister: jest.fn(),
    }));
    return require('../../../src/core/lifecycle/destroy') as typeof DestroyNS;
  }

  function collected(): { emit: Emit; seen: Seen[] } {
    const seen: Seen[] = [];
    return { seen, emit: ((event: Seen) => seen.push(event)) as never };
  }

  it('warns, keeps the record and still drops the edge route', async () => {
    const destroy = await load();
    const ws = await makeUnremovable('kub', { runtime: 'kubernetes', namespace: 'houston-kub' });
    config.updateConfig((cfg) => {
      cfg.default_repro = 'kub';
    });
    const { emit, seen } = collected();

    // The whole Kubernetes teardown, not the helper alone: the route drop is the step
    // that must stay reachable after the record refuses to go.
    await expect(destroy.teardownKubernetes('kub', true, emit)).resolves.toEqual({
      name: 'kub',
      removed: true,
      found: true,
      runtime: 'kubernetes',
      context: 'kind-houston-local',
    });

    expect(await paths.exists('kub')).toBe(true);
    expect(seen.some((event) => event.message.includes('could not be removed'))).toBe(true);
    // Said before the cluster is asked anything: the teardown takes up to a minute.
    expect(seen[0]?.message).toBe("removing 'kub' from its cluster, which can take a minute");
    expect(config.loadConfig().default_repro).toBeUndefined();
    const routes = require('../../../src/core/edge/routes') as unknown as { deregister: jest.Mock };
    expect(routes.deregister).toHaveBeenCalledWith('kub');
    await restore(ws);
  });

  it('brings a Compose teardown to a close too', async () => {
    // `teardownCompose` deletes the record through `runner.remove`, which earlier releases
    // made a removal that ignores errors. A rejection there left the default set and the
    // command failed after the containers were already down.
    const destroy = await load();
    const ws = await makeUnremovable('cmp', { runtime: 'docker', deployment: 'monolith' });
    config.updateConfig((cfg) => {
      cfg.default_repro = 'cmp';
    });
    const { emit } = collected();

    await expect(destroy.teardownCompose('cmp', true)).resolves.toBeUndefined();
    expect(config.loadConfig().default_repro).toBeUndefined();
    await restore(ws);
    void emit;
  });
});

describe('tearing down a Kubernetes workspace that has the monitoring stack', () => {
  afterEach(() => {
    for (const id of [
      '../../../src/core/kube/operator',
      '../../../src/core/kube/monitoring',
      '../../../src/core/kube/namespace',
      '../../../src/core/lifecycle/ready',
    ]) {
      jest.dontMock(id);
    }
    jest.dontMock('../../../src/core/edge/routes');
    jest.resetModules();
  });

  function load() {
    jest.resetModules();
    const called: Record<string, { excluding?: string }> = {};
    const stopped: number[] = [];
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...jest.requireActual('../../../src/core/kube/operator'),
      removeOperator: async (opts: { excluding?: string }) => {
        called.operator = opts;
        return true;
      },
    }));
    jest.doMock('../../../src/core/kube/monitoring', () => ({
      ...jest.requireActual('../../../src/core/kube/monitoring'),
      removeMonitoring: async (opts: { excluding?: string }) => {
        called.monitoring = opts;
        return true;
      },
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      namespaceFor: async () => 'houston-mon',
      deleteNamespace: async () => true,
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      stopPortForward: (pid: number) => {
        stopped.push(pid);
      },
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister: jest.fn(),
    }));
    return {
      called,
      stopped,
      destroy: require('../../../src/core/lifecycle/destroy') as typeof DestroyNS,
    };
  }

  const extra = {
    runtime: 'kubernetes',
    namespace: 'houston-mon',
    context: 'default',
    monitoring: true,
    grafana_pid: 4242,
  };

  it('takes the stack and the Grafana forward with it on --volumes, and only the forward on a plain down', async () => {
    // Reported from a live k3s box: after `down --volumes` the monitoring stack was still
    // running -- ten pods and ~840 MB wanted by nobody -- and the Grafana forward went on
    // holding :5050, so the next `up --monitor` was refused for a port held by a corpse.
    const { called, stopped, destroy } = load();
    await writeRecord('mon', metadata({ name: 'mon', project: 'p', extra }));
    await destroy.teardownKubernetes('mon', true, () => undefined);
    expect(stopped).toContain(4242);
    // The namespace being destroyed must not count as still wanting it: a namespace still
    // Terminating is still listed and still labelled.
    expect(called.monitoring?.excluding).toBe('houston-mon');
    expect(called.operator?.excluding).toBe('houston-mon');

    // A plain `down` keeps the namespace and the data, so the workspace can come back and
    // the stack it wants must stay with it. Its Grafana FORWARD goes: the re-up writes a new
    // record, and one left running was named by nothing -- it outlived `down --volumes`
    // holding :5050. The re-up attaches monitoring again and starts its own.
    for (const key of Object.keys(called)) delete called[key];
    stopped.length = 0;
    await writeRecord('mon', metadata({ name: 'mon', project: 'p', extra }));
    await destroy.teardownKubernetes('mon', false, () => undefined);
    expect(called).toEqual({});
    expect(stopped).toContain(4242);
  });

  it("says a plain down leaves the preset's services running, which it does on purpose", async () => {
    // Measured on k3s: after `down` (data kept) openldap and phpldapadmin stayed 1/1 Running
    // while `list` said down, and nothing had said so.
    const { destroy } = load();
    // What the TERMINAL prints, through the CLI's own printer: emitted in phase `done`, the
    // line reached houston.log and the GUI and was dropped from `houston down` (live, k3s).
    const { emitOf } = require('../../../src/cli/handlers') as typeof HandlersNS;
    const said = async (
      preset: string,
      volumes: boolean,
      ports: number[] = [],
    ): Promise<string> => {
      const printed: string[] = [];
      const io = { writeOut: (text: string) => printed.push(text), writeErr: () => undefined };
      const own = { ...extra, ...(ports.length > 0 ? { sidecar_ports: ports } : {}) };
      await writeRecord('mon', metadata({ name: 'mon', project: 'p', preset, extra: own }));
      await destroy.teardownKubernetes(
        'mon',
        volumes,
        emitOf({ events: null } as never, io as never),
      );
      return printed.join('');
    };
    expect(await said('ldap', false, [8082])).toContain(
      'its ldap services keep running in houston-mon until `down --volumes`',
    );
    expect(await said('default', false)).not.toContain('keep running');
    expect(await said('ldap', true, [8082])).not.toContain('keep running');
    // A preset that is settings and users only runs nothing to keep running.
    expect(await said('e2ee', false)).not.toContain('keep running');
  });
});

describe('the repair notes of a workspace that is torn down', () => {
  afterEach(() => {
    for (const id of [
      '../../../src/core/lifecycle/ownership',
      '../../../src/core/lifecycle/preconditions',
      '../../../src/core/audit',
      '../../../src/core/edge/networks',
      '../../../src/core/edge/routes',
      '../../../src/core/runner/engine',
      '../../../src/core/kube/namespace',
      '../../../src/core/kube/operator',
      '../../../src/core/kube/monitoring',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  function load() {
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ownership', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ownership'),
      mayDestroy: async () => [true, ''],
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      requireEngine: async () => undefined,
    }));
    jest.doMock('../../../src/core/audit', () => ({
      ...jest.requireActual('../../../src/core/audit'),
      record: () => undefined,
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach: async () => undefined,
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister: () => undefined,
    }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      stop: async () => 0,
      down: async () => 0,
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      deleteNamespace: async () => true,
    }));
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...jest.requireActual('../../../src/core/kube/operator'),
      removeOperator: async () => false,
    }));
    jest.doMock('../../../src/core/kube/monitoring', () => ({
      ...jest.requireActual('../../../src/core/kube/monitoring'),
      removeMonitoring: async () => true,
    }));
    return {
      destroy: require('../../../src/core/lifecycle/destroy') as typeof DestroyNS,
      journal: require('../../../src/core/journal') as typeof JournalNS,
    };
  }

  it('says it is waiting when another command holds the workspace, then goes ahead', async () => {
    // `down --volumes` behind a running `backup` waited for the whole backup in silence.
    const { destroy } = load();
    const { reproLock } = require('../../../src/core/runner/locks') as {
      reproLock: <T>(name: string, body: () => Promise<T>) => Promise<T>;
    };
    await writeRecord('busy', metadata({ name: 'busy', project: 'houston-busy' }));
    const gate = { release: (): void => undefined, taken: false };
    const held = reproLock(
      'busy',
      () =>
        new Promise<void>((done) => {
          gate.release = done;
          gate.taken = true;
        }),
    );
    for (let wait = 0; wait < 200 && !gate.taken; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const said: string[] = [];
    const down = destroy.teardown('busy', { emit: (event) => void said.push(event.message) });
    for (let wait = 0; wait < 100 && said.length === 0; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(said[0]).toContain("another houston command is working on 'busy'");
    gate.release();
    await held;
    await down;
    expect(said.at(-1)).toBe("'busy' down (data kept)");
  });

  it('takes them on --volumes, keeps them on a plain down, and leaves every other subject alone', async () => {
    // Seen on the owner's box: 28 `create_unfinished` notes for `alice-rc8-5-1`, all still
    // there after `down --volumes` had removed its containers, its volume and its record, so
    // `doctor` went on advising `houston ready` on a workspace that was gone. Both runtimes,
    // because they delete the record in different places. A cluster note under the same
    // name is about a CLOUD CLUSTER, and another workspace's notes are not this one's.
    const { destroy, journal } = load();
    await fs.rm(journal.journalDir(), { recursive: true, force: true });
    const notes = (name?: string): string[] =>
      journal
        .openEntries()
        .filter((e) => name === undefined || e.workspace === name)
        .map((e) => `${e.kind}:${e.workspace}`)
        .sort();

    journal.record(journal.CREATE_UNFINISHED, 'bystander');
    const runtimes: Record<string, Record<string, unknown>> = {
      'notes-cmp': { runtime: 'docker' },
      'notes-kub': { runtime: 'kubernetes', namespace: 'houston-notes-kub', context: 'default' },
    };
    for (const [name, extra] of Object.entries(runtimes)) {
      await writeRecord(name, metadata({ name, project: `houston-${name}`, extra }));
      for (const kind of [
        journal.CREATE_UNFINISHED,
        journal.CREATE_UNFINISHED,
        journal.RATE_LIMITER_OFF,
        journal.CLUSTER_UNFINISHED,
      ]) {
        journal.record(kind, name);
      }

      await destroy.teardown(name, { volumes: false });
      expect(await paths.exists(name)).toBe(true);
      expect(notes(name)).toHaveLength(4);

      await destroy.teardown(name, { volumes: true, confirm: true });
      expect(await paths.exists(name)).toBe(false);
      expect(notes(name)).toEqual([`cluster_unfinished:${name}`]);
    }

    expect(notes()).toEqual([
      'cluster_unfinished:notes-cmp',
      'cluster_unfinished:notes-kub',
      'create_unfinished:bystander',
    ]);
  });
});

describe('closing pooled edge connections before a Compose teardown', () => {
  afterEach(() => {
    for (const id of [
      '../../../src/core/edge/networks',
      '../../../src/core/edge/routes',
      '../../../src/core/runner/engine',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  function load(stopCode = 0) {
    jest.resetModules();
    const state = { attached: true, pooledSocketOpen: true };
    const stop = jest.fn(async () => {
      if (stopCode === 0 && state.attached) state.pooledSocketOpen = false;
      return stopCode;
    });
    const down = jest.fn(async () => {
      // A removed endpoint cannot deliver the backend's close to the old socket.
      if (state.attached) state.pooledSocketOpen = false;
      return 0;
    });
    const detach = jest.fn(async () => {
      state.attached = false;
    });
    const deregister = jest.fn();
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      stop,
      down,
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach,
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister,
    }));
    return {
      state,
      stop,
      down,
      detach,
      deregister,
      destroy: require('../../../src/core/lifecycle/destroy') as typeof DestroyNS,
    };
  }

  it.each([false, true])(
    'closes the warmed upstream socket before removing its endpoint (volumes=%s)',
    async (volumes) => {
      // Observed live on rootless Podman: detach left an ESTABLISHED old-IP socket,
      // which the unchanged edge reused after re-up while fresh backend GETs worked.
      const { state, stop, down, detach, deregister, destroy } = load();
      await writeRecord('warmed', metadata({ name: 'warmed', project: 'houston-warmed' }));
      await writeRecord('bystander', metadata({ name: 'bystander', project: 'houston-bystander' }));

      await destroy.teardownCompose('warmed', volumes);

      expect(state.pooledSocketOpen).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith('warmed');
      expect(detach).toHaveBeenCalledWith('warmed');
      expect(down).toHaveBeenCalledWith('warmed', { volumes });
      expect(deregister).toHaveBeenCalledWith('warmed');
      expect(await paths.exists('warmed')).toBe(!volumes);
      expect(await paths.exists('bystander')).toBe(true);
    },
  );

  it('says what it is doing before each slow step, so neither front-end reads as hung', async () => {
    // A `down` emitted nothing until its final line: the GUI's job dialog stayed empty and the
    // terminal silent through the whole stop and removal, which the owner read as a hang.
    const { stop, down, destroy } = load();
    await writeRecord('warmed', metadata({ name: 'warmed', project: 'houston-warmed' }));
    const said: string[] = [];
    stop.mockImplementationOnce(async () => {
      said.push('<compose stop>');
      return 0;
    });
    down.mockImplementationOnce(async () => {
      said.push('<compose down>');
      return 0;
    });
    await destroy.teardownCompose('warmed', true, (event) => void said.push(event.message));
    expect(said).toEqual([
      "stopping 'warmed': each service closes cleanly first, which can take several seconds",
      '<compose stop>',
      "removing 'warmed's containers and network, data volume and record",
      '<compose down>',
    ]);
  });

  it("streams docker's own lines into a GUI job, and leaves the terminal's calls as they were", async () => {
    // The GUI shows only emitted events; docker's lines went to the server's stdout, so a voice
    // lab's 9 s FreeSWITCH shutdown was one silent wait in the job dialog.
    const { stop, down, destroy } = load();
    await writeRecord('warmed', metadata({ name: 'warmed', project: 'houston-warmed' }));
    stop.mockImplementationOnce((async (_name: string, onLine?: (line: string) => void) => {
      onLine?.('Container houston-warmed-freeswitch-1 Stopping');
      return 0;
    }) as never);
    const seen: { message: string; echo: unknown }[] = [];
    await destroy.teardownCompose(
      'warmed',
      false,
      (event) => void seen.push({ message: event.message, echo: event.data.echo }),
      true,
    );
    expect(seen).toContainEqual({
      message: 'Container houston-warmed-freeswitch-1 Stopping',
      echo: 'docker',
    });
    expect(down).toHaveBeenCalledWith('warmed', { volumes: false, onLine: expect.any(Function) });
    // The terminal: no line callback, so docker keeps drawing its own output there.
    stop.mockClear();
    await writeRecord('plain', metadata({ name: 'plain', project: 'houston-plain' }));
    await destroy.teardownCompose('plain', false);
    expect(stop).toHaveBeenCalledWith('plain');
    expect(down).toHaveBeenLastCalledWith('plain', { volumes: false });
  });

  it('keeps the endpoint, route, data and record when the graceful stop fails', async () => {
    const { state, down, detach, deregister, destroy } = load(1);
    await writeRecord('warmed', metadata({ name: 'warmed', project: 'houston-warmed' }));

    await expect(destroy.teardownCompose('warmed', true)).rejects.toThrow(
      "`docker compose stop` failed for 'warmed'",
    );

    expect(state).toEqual({ attached: true, pooledSocketOpen: true });
    expect(detach).not.toHaveBeenCalled();
    expect(down).not.toHaveBeenCalled();
    expect(deregister).not.toHaveBeenCalled();
    expect(await paths.exists('warmed')).toBe(true);
  });

  it('keeps the endpoint attached until the graceful stop has completed', async () => {
    const { state, stop, down, detach, destroy } = load();
    let releaseStop = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    stop.mockImplementationOnce(async () => {
      await held;
      if (state.attached) state.pooledSocketOpen = false;
      return 0;
    });
    const tearingDown = destroy.teardownCompose('warmed', false);
    try {
      await Promise.resolve();
      expect(state.attached).toBe(true);
      expect(detach).not.toHaveBeenCalled();
      expect(down).not.toHaveBeenCalled();
    } finally {
      releaseStop();
      await tearingDown;
    }
    expect(state.pooledSocketOpen).toBe(false);
    expect(detach).toHaveBeenCalledWith('warmed');
    expect(down).toHaveBeenCalledWith('warmed', { volumes: false });
  });
});

describe('a Kubernetes record with Docker containers left under its name', () => {
  afterEach(() => {
    for (const id of [
      '../../../src/core/lifecycle/preconditions',
      '../../../src/core/edge/networks',
      '../../../src/core/edge/routes',
      '../../../src/core/runner/engine',
      '../../../src/core/kube/namespace',
      '../../../src/core/kube/operator',
      '../../../src/core/kube/monitoring',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  function load(downCode = 0) {
    jest.resetModules();
    const calls: string[] = [];
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      requireEngine: async () => undefined,
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach: async (name: string) => void calls.push(`detach ${name}`),
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister: () => undefined,
    }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      stop: async (name: string) => {
        calls.push(`stop ${name}`);
        return 0;
      },
      down: async (name: string, { volumes = false } = {}) => {
        calls.push(`down ${name}${volumes ? ' -v' : ''}`);
        return downCode;
      },
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      namespaceFor: async (name: string) => `houston-${name}`,
      deleteNamespace: async () => {
        calls.push('delete namespace');
        return true;
      },
    }));
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...jest.requireActual('../../../src/core/kube/operator'),
      removeOperator: async () => false,
    }));
    jest.doMock('../../../src/core/kube/monitoring', () => ({
      ...jest.requireActual('../../../src/core/kube/monitoring'),
      removeMonitoring: async () => true,
    }));
    return { calls, destroy: require('../../../src/core/lifecycle/destroy') as typeof DestroyNS };
  }

  async function mixed(name: string): Promise<void> {
    // What 2.1.1's Kubernetes create left of a Docker workspace it took over: a Kubernetes
    // record, and the Docker workspace's compose file beside it.
    await writeRecord(
      name,
      metadata({
        name,
        project: `houston-${name}`,
        extra: { runtime: 'kubernetes', context: 'default' },
      }),
    );
    await fs.writeFile(`${paths.workspace(name)}/docker-compose.yml`, 'services: {}\n');
  }

  it('brings the Docker containers down with their data before the namespace and the record go', async () => {
    const { calls, destroy } = load();
    await mixed('both');
    await destroy.teardown('both', { volumes: true, confirm: true });
    expect(calls).toEqual(['stop both', 'detach both', 'down both -v', 'delete namespace']);
    expect(await paths.exists('both')).toBe(false);
  });

  it('removes nothing when the Docker containers will not go, and says how to remove them', async () => {
    const { calls, destroy } = load(1);
    await mixed('stuck');
    await expect(destroy.teardown('stuck', { volumes: true, confirm: true })).rejects.toThrow(
      '`docker compose -p houston-stuck down -v` removes them',
    );
    expect(calls).not.toContain('delete namespace');
    expect(await paths.exists('stuck')).toBe(true);
  });

  it('asks again under the lock, so a workspace handed over while down --volumes waited is kept', async () => {
    // The owner was asked before the wait for the lock and not after: bob's `down --volumes`
    // queued behind a backup deleted the workspace that had meanwhile been handed to alice.
    const { calls, destroy } = load();
    await writeRecord(
      'ho',
      metadata({ name: 'ho', project: 'houston-ho', extra: { created_by: 'bob' } }),
    );
    const { reproLock } = require('../../../src/core/runner/locks') as {
      reproLock: <T>(name: string, body: () => Promise<T>) => Promise<T>;
    };
    const { runWithContext } = require('../../../src/lib/context') as {
      runWithContext: <T>(values: { actor: string }, fn: () => T) => T;
    };
    const gate = { release: (): void => undefined, taken: false };
    const held = reproLock(
      'ho',
      () =>
        new Promise<void>((done) => {
          gate.release = done;
          gate.taken = true;
        }),
    );
    for (let wait = 0; wait < 200 && !gate.taken; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const said: string[] = [];
    const down = runWithContext({ actor: 'bob' }, () =>
      destroy.teardown('ho', {
        volumes: true,
        confirm: true,
        emit: (event) => void said.push(event.message),
      }),
    ).then(
      () => '',
      (error: Error) => error.message,
    );
    for (let wait = 0; wait < 100 && said.length === 0; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(said[0]).toContain("another houston command is working on 'ho'");
    await writeRecord(
      'ho',
      metadata({ name: 'ho', project: 'houston-ho', extra: { created_by: 'bob', owner: 'alice' } }),
    );
    gate.release();
    await held;
    expect(await down).toContain('ho belongs to alice');
    expect(calls).toEqual([]);
    expect(await paths.exists('ho')).toBe(true);
    // A refusal is not also written down as done.
    const audit = await fs.readFile(`${config.home()}/audit.log`, 'utf8');
    expect(audit.split('\n').filter((line) => line.includes('\tdown-volumes\tho\t'))).toEqual([
      expect.stringMatching(/denied/u),
    ]);
  });

  it('asks nothing of Docker for a Kubernetes workspace that has no compose file', async () => {
    const { calls, destroy } = load();
    await writeRecord(
      'pure',
      metadata({
        name: 'pure',
        project: 'houston-pure',
        extra: { runtime: 'kubernetes', context: 'default' },
      }),
    );
    await destroy.teardown('pure', { volumes: true, confirm: true });
    expect(calls).toEqual(['delete namespace']);
  });
});
