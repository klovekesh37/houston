import * as os from 'node:os';

jest.mock('node:os', () => ({
  ...jest.requireActual<typeof os>('node:os'),
  networkInterfaces: jest.fn(),
}));

import { ingressEndpoint } from '../../../src/core/kube/endpoints';
import { kube } from '../../../src/core/kube/exec';

const original = kube.run;
afterEach(() => {
  kube.run = original;
  jest.mocked(os.networkInterfaces).mockReset();
});

/** One LoadBalancer Service publishing :80 at `ip`, as `kubectl get svc -A -o json` lists it. */
function lb(ip: string): void {
  kube.run = (argv) =>
    Promise.resolve({
      argv,
      returncode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            metadata: { namespace: 'traefik', name: 'traefik' },
            spec: { type: 'LoadBalancer', ports: [{ port: 80, nodePort: 30562 }] },
            status: { loadBalancer: { ingress: [{ ip }] } },
          },
        ],
      }),
    });
}

/** This machine with a Docker bridge 172.19.0.1/16 (where kind puts its node) and eth0. */
function interfaces(): void {
  const entry = (address: string, cidr: string): os.NetworkInterfaceInfo => ({
    address,
    netmask: '',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr,
  });
  jest.mocked(os.networkInterfaces).mockReturnValue({
    'br-1a2b3c': [entry('172.19.0.1', '172.19.0.1/16')],
    eth0: [entry('10.0.0.5', '10.0.0.5/24')],
  });
}

describe('where a cluster ingress answers', () => {
  it("counts a kind node on this machine's Docker bridge as this machine", async () => {
    // Measured on a real domain: kind's Traefik LoadBalancer reports the node's address
    // (172.19.0.2), which no host interface carries. Called remote, the http-01 challenge
    // was never routed through the edge and the certificate never issued.
    interfaces();
    lb('172.19.0.2');
    expect(await ingressEndpoint('kind-houston-local', { port: 80 })).toMatchObject({
      address: '172.19.0.2',
      source: 'loadbalancer',
      local: true,
    });
  });

  it('keeps a load balancer elsewhere remote, kind or not', async () => {
    interfaces();
    lb('203.0.113.10');
    expect(await ingressEndpoint('kind-houston-local', { port: 80 })).toMatchObject({
      local: false,
    });
  });

  it('applies the Docker-bridge rule to kind clusters only', async () => {
    // A k3s or remote cluster's address on a bridge subnet is not evidence it runs here.
    interfaces();
    lb('172.19.0.2');
    expect(await ingressEndpoint('prod', { port: 80 })).toMatchObject({ local: false });
  });
});
