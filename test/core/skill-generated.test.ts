/**
 * The shipped skill file is what the build would generate now, not a hand-edited copy.
 *
 * The file once said exit code 6 was reserved while three places raised it, because a
 * person restated the contract in prose. `tools/skill-generate.js` renders the
 * contract-bearing parts from `capabilities()` and keeps the prose in a template; this
 * holds data/skill/SKILL.md to a fresh render. A contract change without `node
 * tools/skill-generate.js` fails here, which is the point.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { capabilities } from '../../src/cli/capabilities';

const ROOT = path.resolve(__dirname, '..', '..');
const generator = require(path.join(ROOT, 'tools', 'skill-generate.js')) as {
  TARGET: string;
  TEMPLATE: string;
  render: (manifest: unknown, template: string, version: string, pkg?: unknown) => string;
};
const PKG = require('../../package.json') as { name: string; version: string };
const VERSION = PKG.version;

describe('the shipped skill file', () => {
  it('skill file matches capabilities', () => {
    const fresh = generator.render(
      capabilities(),
      fs.readFileSync(generator.TEMPLATE, 'utf8'),
      VERSION,
      PKG,
    );
    expect(fs.readFileSync(generator.TARGET, 'utf8')).toBe(fresh);
  });

  it('is loaded for a support ticket and for any other use of a workspace, but not for load', () => {
    // The owner's wording: a support ticket is one use among several, so the description names
    // both, and an agent that only met ticket wording never reached for houston to try a PR's
    // build. Load testing is left out of the skill for now, generated list included.
    const shipped = fs.readFileSync(generator.TARGET, 'utf8');
    const description = /^description: (.*)$/mu.exec(shipped)?.[1] ?? '';
    expect(description).toContain(
      'reproduce a support ticket or reported behaviour, check whether a bug is version-specific, or compare two versions',
    );
    expect(description).toContain('try a feature or setting');
    expect(shipped).not.toMatch(/loadtest|load-test|houston capacity|`capacity`/u);
  });

  it('names the package to install, as package.json names it', () => {
    // An agent on a machine without houston had no install line and would not guess one;
    // rendered, so a rename of the package cannot leave the skill naming the old one.
    expect(fs.readFileSync(generator.TARGET, 'utf8')).toContain(`npm install -g ${PKG.name}`);
  });

  it("names the safe cluster read, and keep, share and a person's workspace among what to ask about first", () => {
    // An agent was told to ask before `cluster create` and `cluster delete`, but not before
    // `keep` (it moves a cluster's deletion date) or `share` (it grants AWS access), and
    // was never told which cluster command only reads. Driven live, an agent also removed the
    // workspace a person had asked for to free a preset's port, because nothing said to ask.
    const shipped = fs.readFileSync(generator.TARGET, 'utf8');
    expect(shipped).toContain('`houston cluster overview --json` | the safe read');
    const ask = shipped.slice(
      shipped.indexOf('### Ask a person first'),
      shipped.indexOf('## Three standing rules'),
    );
    expect({
      keep: ask.includes('`cluster keep`'),
      share: ask.includes('`cluster share`'),
      person: ask.includes('removing a workspace the person asked for'),
    }).toEqual({
      keep: true,
      share: true,
      person: true,
    });
  });

  it('never tells an agent to attach the admin password', () => {
    // `info --json` carries `data.login.password` (the 1.x payload, which the skill itself
    // reads to tell the person how to log in), generated for any workspace reachable beyond
    // loopback. The skill called that whole record "the record to attach".
    const shipped = fs.readFileSync(generator.TARGET, 'utf8');
    const collect = shipped.slice(
      shipped.indexOf('### The record to share'),
      shipped.indexOf('### Tear it down'),
    );
    expect(collect).toContain('the record to attach');
    expect(collect).toContain("jq 'del(.data.login.password)'");
  });

  it('refuses to render an exit code it has no prose for, and prose for a code the build lacks', () => {
    const manifest = capabilities() as { exit_codes: Record<string, string> };
    const template = fs.readFileSync(generator.TEMPLATE, 'utf8');
    const extra = { ...manifest, exit_codes: { ...manifest.exit_codes, '9': 'teapot' } };
    expect(() => generator.render(extra, template, VERSION)).toThrow(/teapot.*no prose/u);
    const fewer = {
      ...manifest,
      exit_codes: Object.fromEntries(
        Object.entries(manifest.exit_codes).filter(([, n]) => n !== 'gate'),
      ),
    };
    expect(() => generator.render(fewer, template, VERSION)).toThrow(/names gate/u);
  });
});
