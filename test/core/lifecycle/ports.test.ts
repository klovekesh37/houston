/**
 * `core/lifecycle/ports`: which host port a workspace gets, and what its record says it is.
 */
import type * as ErrorsNS from '../../../src/lib/errors';
import { nullEmit } from '../../../src/lib/events';
import { emptyPreset } from '../../../src/lib/presets/types';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as PortsNS from '../../../src/core/lifecycle/ports';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as TypesNS from '../../../src/core/lifecycle/types';
import type * as VersionsNS from '../../../src/lib/versions';

const ISOLATED = [
  '../../../src/core/runner/ports',
  '../../../src/core/runner/paths',
  '../../../src/core/runner/record',
  '../../../src/core/runner/queries',
  '../../../src/core/lifecycle/ports',
  '../../../src/core/lifecycle/sizing',
  '../../../src/core/lifecycle/ready',
  '../../../src/lib/versions',
];

afterEach(() => {
  for (const module of ISOLATED) jest.dontMock(module);
  jest.resetModules();
});

describe('picking a host port', () => {
  it('refuses a port another workspace already claims', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/ports'),
      usedPorts: async () => new Set([8300]),
    }));
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    // The class from the SAME registry the fresh module threw from: after `resetModules` an
    // import at the top of this file is a different class object with the same name.
    const { ConflictError } = require('../../../src/lib/errors') as typeof ErrorsNS;
    await expect(ports.pickHostPort(8300, emptyPreset('default'), '')).rejects.toThrow(
      ConflictError,
    );
  });
});

describe("an explicit --port beside the presets' own ports", () => {
  it("refuses an instance port that lands on one of the workspace's side ports", async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/ports'),
      usedPorts: async () => new Set<number>(),
      portFree: async () => true,
    }));
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    const pre = { instances: 2, ports: [8081] } as Parameters<typeof PortsNS.pickHostPort>[1];
    await expect(ports.pickHostPort(8080, pre, '')).rejects.toThrow(
      "--port 8080: instance port 8081 is also a port this workspace's presets publish",
    );
    await expect(ports.pickHostPort(8090, pre, '')).resolves.toBe(8090);
  });
});

describe('the side ports a preset publishes, once per box', () => {
  it('names who holds them before a create is tried, and refuses the create the same way', async () => {
    // A restore as new builds its preset again. While another workspace holds its side
    // ports the create is refused, and the GUI learned that from a job that had started.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/ports'),
      portFree: async () => true,
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    const meta = (name: string, preset: string, sidecar: number[]) =>
      record.metadata({
        name,
        project: `houston-${name}`,
        preset,
        hostPort: 3000,
        extra: { sidecar_ports: sidecar },
      });
    await record.write('mail-src', 'services: {}\n', meta('mail-src', 'email+ldap', [8025, 8082]));
    await record.write('plain', 'services: {}\n', meta('plain', 'default', []));

    expect(await ports.sidecarHolder('ldap+email')).toEqual({
      name: 'mail-src',
      ports: [8025, 8082],
    });
    expect(await ports.sidecarHolder('email')).toEqual({ name: 'mail-src', ports: [8025] });
    expect(await ports.sidecarHolder('saml')).toBeNull();
    expect(await ports.sidecarHolder('default')).toBeNull();
    expect(await ports.sidecarHolder('')).toBeNull();

    const pre = (name: string, published: number[]) =>
      ({ name, ports: published }) as unknown as Parameters<typeof PortsNS.checkSidecarPorts>[0];
    await expect(ports.checkSidecarPorts(pre('email', [8025]))).rejects.toThrow(
      "preset 'email' publishes port(s) [8025], already claimed by workspace 'mail-src'. " +
        "A preset's ports are fixed, so only one workspace on this machine can use them at a " +
        'time; its owner frees them with houston down --name mail-src --volumes',
    );
    // A remedy that deletes data says so: the record holds the port even while only `down`,
    // so this is the only way through, and it read like a routine cleanup.
    await expect(ports.checkSidecarPorts(pre('email', [8025]))).rejects.toThrow(
      '--volumes (that deletes its data)',
    );
    // Its own ports are not a claim against itself.
    await expect(
      ports.checkSidecarPorts(pre('email', [8025]), 'mail-src'),
    ).resolves.toBeUndefined();
    await expect(ports.checkSidecarPorts(pre('saml', [8081]))).resolves.toBeUndefined();
  });

  it("names the holder's owner and leaves freeing the port to them", async () => {
    // On a shared server the holder is usually a colleague's: the refusal told the reader to
    // delete it, data and all, without saying whose it was or that the port is one per machine.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/ports'),
      portFree: async () => true,
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    await record.write(
      'bob-t1',
      'services: {}\n',
      record.metadata({
        name: 'bob-t1',
        project: 'houston-bob-t1',
        preset: 'email',
        hostPort: 3000,
        extra: { sidecar_ports: [8025], created_by: 'bob', monitoring_ports: [9090, 5050] },
      }),
    );
    const pre = { name: 'email', ports: [8025] } as unknown as Parameters<
      typeof PortsNS.checkSidecarPorts
    >[0];
    let said = '';
    await ports.checkSidecarPorts(pre).catch((error: unknown) => (said = String(error)));
    expect(said).toContain("already claimed by workspace 'bob-t1' (bob's)");
    expect(said).toContain('only one workspace on this machine can use them');
    expect(said).toContain('its owner frees them with houston down --name bob-t1 --volumes');
    expect(said).not.toContain('delete it first');
    let monitoring = '';
    await ports.checkMonitorPorts().catch((error: unknown) => (monitoring = String(error)));
    expect(monitoring).toContain(
      "already used by workspace 'bob-t1' (bob's). Monitoring's ports are fixed",
    );
    expect(monitoring).toContain('its owner frees them with houston monitor --name bob-t1 --off');
  });
});

describe('the recorded root_url', () => {
  it('is always the local port, while Rocket.Chat still advertises the override', async () => {
    // A record's root_url is what houston's OWN calls use -- login, PAT, seeding, load tests,
    // and `ready`, which polls it. `--root-url` used to displace it with a public https name,
    // and `ready` then waited 300s on DNS while localhost answered 200 the whole time.
    const written: { yaml: string; meta: RecordNS.Metadata }[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/paths', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/paths'),
      exists: async () => false,
    }));
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    // No MongoDB left by another home; there is no Docker here to answer that ask.
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      projectDataVolumes: async () => [],
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ports'),
      checkSidecarPorts: async () => undefined,
      pickHostPort: async () => 3001,
    }));
    jest.doMock('../../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsNS>('../../../src/lib/versions');
      return {
        ...actual,
        resolve: (version: string) => actual.resolve(version, { offline: true }),
      };
    });
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/record'),
      write: async (_name: string, yaml: string, meta: RecordNS.Metadata) => {
        written.push({ yaml, meta });
      },
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ready'),
      upCompose: async () => 0,
    }));
    const { createRepro } =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const { createReq } = require('../../../src/core/lifecycle/types') as typeof TypesNS;

    await createRepro(
      createReq({
        version: '8.5.1',
        name: 'urlcase',
        rootUrl: 'https://lab.example.com',
        wait: false,
        offline: true,
      }),
      nullEmit,
    );

    expect(written).toHaveLength(1);
    expect(written[0]?.meta.rootUrl).toBe('http://localhost:3001');
    // ...or `--root-url` would do nothing at all.
    expect(written[0]?.yaml).toContain('ROOT_URL: https://lab.example.com');
  });
});

describe('a port block past the top of the range', () => {
  it('is refused as a validation error, not truncated', async () => {
    // Three instances need a four-port block, and 65535 has no room for one.
    jest.resetModules();
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    const { ValidationError } = require('../../../src/lib/errors') as typeof ErrorsNS;
    await expect(
      ports.pickHostPort(65535, { ...emptyPreset('default'), instances: 3 }, ''),
    ).rejects.toThrow(ValidationError);
  });
});
