import Fastify from 'fastify';

import { createApp } from '../../../src/web/app';
import {
  installRouteCompleteness,
  ownerScoped,
  ROUTE_ROLES,
  toBraceRouteKey,
  toBraceTemplate,
  toFastifyRouteKey,
  toFastifyTemplate,
  unlistedRoutes,
} from '../../../src/web/route-table';

describe('the default-deny route table', () => {
  it('translates every parameter in both directions and preserves the explicit WS sentinel', () => {
    expect(toFastifyTemplate('/api/:literal/{one}/x/{two}')).toBe('/api/:literal/:one/x/:two');
    expect(toBraceTemplate('/api/:one/x/:two')).toBe('/api/{one}/x/{two}');
    expect(toFastifyRouteKey(['GET', '/api/{one}/{two}'])).toEqual(['GET', '/api/:one/:two']);
    expect(toBraceRouteKey(['GET', '/api/:one/:two'])).toEqual(['GET', '/api/{one}/{two}']);
    expect(toFastifyRouteKey(['WS', ''])).toEqual(['WS', '']);
    expect(toBraceRouteKey(['WS', ''])).toEqual(['WS', '']);
  });

  it('scopes every member route that names a workspace to its owner, and nothing else', () => {
    // A member sees every workspace and changes only their own. Derived from the table, so a
    // member route added later is scoped without anyone remembering to.
    const scoped = [...ROUTE_ROLES.keys()].filter((key) => {
      const [method = '', template = ''] = key.split(' ');
      return ownerScoped(method, toFastifyTemplate(template));
    });
    for (const key of scoped) {
      expect([key, ROUTE_ROLES.get(key)]).toEqual([key, 'member']);
      expect(key).toContain('{name}');
    }
    expect(scoped).toEqual(
      expect.arrayContaining([
        'POST /api/repros/{name}/state',
        'DELETE /api/repros/{name}',
        'GET /api/repros/{name}/env',
        'POST /api/repros/{name}/env',
        'GET /api/repros/{name}/logs',
        'WS /api/repros/{name}/logs/stream',
        'POST /api/repros/{name}/pat',
        'POST /api/repros/{name}/call',
      ]),
    );
    // Looking stays open; the CLI default is an admin's; creating names no workspace yet.
    for (const key of [
      'GET /api/repros/{name}/detail',
      'POST /api/repros/{name}/default',
      'POST /api/repros',
    ]) {
      expect([key, scoped.includes(key)]).toEqual([key, false]);
    }
    expect(scoped).toHaveLength(22);
  });

  it('finds an omitted route and does not broadly forgive HEAD', () => {
    expect(unlistedRoutes([{ method: 'GET', url: '/api/unlisted', config: {} }])).toEqual([
      'GET /api/unlisted',
    ]);
    expect(
      unlistedRoutes([
        { method: 'GET', url: '/api/health', config: {} },
        { method: 'HEAD', url: '/api/health', config: {} },
      ]),
    ).toEqual(['HEAD /api/health']);
    expect(
      unlistedRoutes([
        { method: 'GET', url: '/api/health', config: {} },
        { method: 'HEAD', url: '/api/health', config: {}, generatedHead: true },
      ]),
    ).toEqual([]);
    expect(
      unlistedRoutes([
        {
          method: 'GET',
          url: '/api/escape',
          config: { houstonSpa: true },
        },
      ]),
    ).toEqual(['GET /api/escape']);
    expect(
      unlistedRoutes([
        {
          method: 'HEAD',
          url: '/api/health',
          config: {},
          generatedHead: false,
        },
      ]),
    ).toEqual(['HEAD /api/health']);
  });

  it('walks the actual twelve-module Fastify registry with no unlisted route', async () => {
    const app = await createApp({ accounts: false });
    try {
      await expect(app.ready()).resolves.toBe(app);
    } finally {
      await app.close();
    }
  });

  it('does not expose API GET handlers through framework-generated HEAD routes', async () => {
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({ method: 'HEAD', url: '/api/users' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
    } finally {
      await app.close();
    }
  });

  it('rejects a route registered after the completeness hook was installed', async () => {
    const app = Fastify();
    installRouteCompleteness(app);
    app.get('/api/late-unlisted', async () => ({ ok: true }));
    await expect(app.ready()).rejects.toThrow(
      'registered routes missing from ROUTE_ROLES: GET /api/late-unlisted, HEAD /api/late-unlisted',
    );
    await app.close();
  });

  it('cannot acquire a new route after the completeness check has run', async () => {
    const app = Fastify();
    installRouteCompleteness(app);
    app.get('/api/health', async () => ({ ok: true }));
    await app.ready();
    expect(() => app.get('/api/too-late', async () => ({ ok: true }))).toThrow(
      /instance is already listening|already booted/u,
    );
    await app.close();
  });
});
