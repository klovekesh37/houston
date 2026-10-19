#!/usr/bin/env node
/**
 * `yarn skill:eval [--reps N] [--jobs N] [--only id,id] [--model M] [--skill FILE]` -- put
 * each request in tools/skill/evals.json to an agent whose only houston knowledge is the
 * skill, and score the commands it says it would run.
 *
 * WHY. `skill-generate` and the printed-commands invariant prove the skill names real
 * commands and flags. Nothing proved an agent READING it picks the right one for a request:
 * that it refuses a partial version, asks before `trust-ca`, finds `--version pr-<n>`. A case
 * is a request somebody makes and what the answer must hold: `run` and `never_run` are
 * patterns over the commands it would run itself, `ask` over what it would ask the person
 * first, `say` and `never_say` over the whole reply. Run it before a release, and turn each
 * misfire a teammate reports into a case.
 *
 * Each call is `claude -p` with no tools, skills, settings or MCP servers, from an empty
 * directory, so a stale copy in ~/.claude/skills cannot answer in the skill's place. One
 * model turn per case and rep; every reply is written out, because a pattern hit can be a
 * quoted counter-example and the person reading the result should check the failures.
 */
'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CASES = path.join(ROOT, 'tools', 'skill', 'evals.json');

/** The answer's shape: the commands in one fenced block, then what to ask, then what to say. */
function systemPrompt(skill) {
  return [
    'You help someone who works on or with Rocket.Chat. The houston skill below is installed',
    'and is all you know about houston. You cannot run commands in this conversation: plan them.',
    '',
    'Answer in exactly this shape:',
    'RUN:',
    '```bash',
    '<each command you would run yourself, in order, one per line; leave out anything you',
    'would only suggest or would first ask the person about; empty when none is needed>',
    '```',
    'ASK: <each thing you would ask the person, or need them to do, before going on; or none>',
    'TELL: <what you would tell the person afterwards, briefly>',
    '',
    '<skill>',
    skill,
    '</skill>',
  ].join('\n');
}

/** The reply split into what it would run (comments dropped), what it would ask, and all of it. */
function sections(reply) {
  const fence = /```[a-z]*\n([\s\S]*?)```/u.exec(reply);
  const run = (fence?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/u, ''))
    .join('\n');
  const askAt = reply.search(/^ASK:/mu);
  const tellAt = reply.search(/^TELL:/mu);
  const ask = askAt < 0 ? '' : reply.slice(askAt, tellAt > askAt ? tellAt : undefined);
  return { run, ask, all: reply };
}

/** What a reply got wrong for one case: an empty list is a pass. */
function score(reply, kase, vars = {}) {
  const fill = (source) => source.replaceAll(/\{\{(\w+)\}\}/gu, (_, key) => vars[key] ?? '');
  const { run, ask, all } = sections(reply);
  const failures = [];
  const check = (key, text, flags, wanted) => {
    for (const source of kase[key] ?? []) {
      const hit = new RegExp(fill(source), flags).exec(text);
      if (wanted && hit === null) failures.push(`${key}: nothing matches /${source}/`);
      if (!wanted && hit !== null) failures.push(`${key}: /${source}/ matched "${hit[0]}"`);
    }
  };
  check('run', run, 'mu', true);
  check('never_run', run, 'mu', false);
  check('ask', ask, 'imu', true);
  check('say', all, 'imu', true);
  check('never_say', all, 'imu', false);
  return failures;
}

function ask(system, request, model, cwd) {
  const args = [
    '-p',
    '--tools',
    '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--system-prompt',
    system,
    ...(model ? ['--model', model] : []),
    request,
  ];
  return new Promise((resolve, reject) => {
    execFile('claude', args, { cwd, timeout: 600_000, maxBuffer: 16 << 20 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

function option(argv, name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? fallback : argv[at + 1];
}

/**
 * What a run is asked for: its counts, and the cases it scores. Refused when it would score
 * nothing: a mistyped count made no runs, and an empty run printed a full pass.
 */
function settings(argv, allCases) {
  const count = (name, fallback) => {
    const raw = option(argv, name, fallback);
    if (!/^[1-9]\d*$/u.test(raw ?? '')) {
      const got = raw === undefined ? 'nothing' : JSON.stringify(raw);
      throw new Error(`--${name} expects a whole number of 1 or more, got ${got}`);
    }
    return Number(raw);
  };
  const only = option(argv, 'only', '');
  const cases = allCases.filter((kase) => !only || only.split(',').includes(kase.id));
  if (cases.length === 0) throw new Error(`--only ${String(only)} names no case in ${CASES}`);
  return {
    reps: count('reps', '1'),
    jobs: count('jobs', '4'),
    model: option(argv, 'model', ''),
    skill: option(argv, 'skill', path.join(ROOT, 'data', 'skill', 'SKILL.md')),
    cases,
  };
}

async function main() {
  const { reps, jobs, model, cases, ...given } = settings(
    process.argv,
    JSON.parse(fs.readFileSync(CASES, 'utf8')),
  );
  const skill = fs.readFileSync(given.skill, 'utf8');
  const vars = { package: require(path.join(ROOT, 'package.json')).name };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-skill-eval-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-skill-eval-cwd-'));
  const system = systemPrompt(skill);
  const runs = cases.flatMap((kase) => Array.from({ length: reps }, (_, rep) => ({ kase, rep })));
  let passed = 0;
  let next = 0;
  const worker = async () => {
    while (next < runs.length) {
      const { kase, rep } = runs[next++];
      const file = path.join(out, `${kase.id}.${rep + 1}.md`);
      let failures;
      try {
        const reply = await ask(system, kase.request, model, cwd);
        fs.writeFileSync(file, reply, 'utf8');
        failures = reply.trim() === '' ? ['claude -p gave no reply'] : score(reply, kase, vars);
      } catch (error) {
        failures = [`claude -p failed: ${error.message.split('\n')[0]}`];
      }
      if (failures.length === 0) passed += 1;
      const verdict = failures.length > 0 ? 'FAIL' : 'pass';
      process.stdout.write(`${verdict} ${kase.id} #${rep + 1}\n`);
      for (const failure of failures) process.stdout.write(`     ${failure}\n`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  fs.rmSync(cwd, { recursive: true, force: true });
  process.stdout.write(
    `skill-eval: ${String(passed)}/${String(runs.length)} passed; replies in ${out}\n`,
  );
  // Passes counted, not failures subtracted: a run that never happened is not a pass.
  if (passed !== runs.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`skill-eval: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { CASES, score, sections, settings, systemPrompt };
