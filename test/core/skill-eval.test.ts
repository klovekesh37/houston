/**
 * The skill eval's scoring, without a model: `tools/skill-eval.js` asks `claude -p` each
 * request in tools/skill/evals.json and scores the reply, and a scorer that read the wrong
 * part of a reply would report a pass for an agent that ran the wrong command.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
type Case = Record<string, unknown> & { id: string; request: string };
const evals = require(path.join(ROOT, 'tools', 'skill-eval.js')) as {
  CASES: string;
  score: (reply: string, kase: Case, vars?: Record<string, string>) => string[];
  settings: (argv: string[], cases: Case[]) => { reps: number; jobs: number; cases: Case[] };
};

const REPLY = [
  'RUN:',
  '```bash',
  'houston up --version 7.4.1 --name t-1 --wait --json',
  '# after the person agrees: houston trust-ca',
  '```',
  'ASK: run `houston trust-ca` once',
  'TELL: it is up; `houston down --name t-1 --volumes --yes` removes it',
].join('\n');

describe('the skill eval', () => {
  it('scores commands only from the fenced block, with comments dropped', () => {
    const kase = { id: 'x', request: 'r', run: ['--version 7\\.4\\.1'], never_run: ['trust-ca'] };
    expect(evals.score(REPLY, kase)).toEqual([]);
    expect(evals.score(REPLY, { ...kase, run: ['houston down'] })).toEqual([
      'run: nothing matches /houston down/',
    ]);
  });

  it('scores what to ask from ASK, and what to say from the whole reply', () => {
    const kase = { id: 'x', request: 'r', ask: ['trust-ca'], say: ['houston down'] };
    expect(evals.score(REPLY, kase)).toEqual([]);
    expect(evals.score(REPLY, { ...kase, ask: ['houston down'] })).toEqual([
      'ask: nothing matches /houston down/',
    ]);
    expect(evals.score(REPLY, { ...kase, never_say: ['volumes'] })).toEqual([
      'never_say: /volumes/ matched "volumes"',
    ]);
  });

  it('fills {{package}} from the variables it is given', () => {
    const kase = { id: 'x', request: 'r', say: ['npm i -g {{package}}'] };
    expect(evals.score('npm i -g @scope/houston', kase, { package: '@scope/houston' })).toEqual([]);
  });

  it('refuses a run that would score nothing, rather than report a pass', () => {
    // A mistyped --jobs or --reps was NaN: no worker ran, and it printed "15/15 passed", exit 0.
    // An --only naming no case printed "0/0 passed", exit 0.
    const cases = [
      { id: 'a', request: 'r' },
      { id: 'b', request: 'r' },
    ];
    const run =
      (...argv: string[]) =>
      () =>
        evals.settings(['node', 'skill-eval.js', ...argv], cases);
    expect(run('--jobs', 'x')).toThrow('--jobs expects a whole number of 1 or more, got "x"');
    expect(run('--reps', '0')).toThrow('--reps expects a whole number of 1 or more, got "0"');
    expect(run('--jobs')).toThrow('--jobs expects a whole number of 1 or more, got nothing');
    expect(run('--only', 'typo')).toThrow('--only typo names no case');
    expect(run('--reps', '2', '--only', 'b')()).toMatchObject({
      reps: 2,
      jobs: 4,
      cases: [cases[1]],
    });
  });

  it('ships cases with unique ids, a request, and patterns that compile', () => {
    const cases = JSON.parse(fs.readFileSync(evals.CASES, 'utf8')) as Case[];
    expect(cases.length).toBeGreaterThan(5);
    expect(new Set(cases.map((kase) => kase.id)).size).toBe(cases.length);
    for (const kase of cases) {
      expect(kase.request.length).toBeGreaterThan(0);
      const keys = ['run', 'never_run', 'ask', 'say', 'never_say'].filter((key) => key in kase);
      expect(keys.length).toBeGreaterThan(0);
      // As the runner compiles them: `{{package}}` filled first.
      for (const key of keys)
        for (const source of kase[key] as string[])
          expect(() => new RegExp(source.replaceAll('{{package}}', 'pkg'), 'u')).not.toThrow();
    }
  });
});
