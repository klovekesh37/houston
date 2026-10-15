/**
 * One person's agent files never reach the repository.
 *
 * `.claude/` and `.agents/` hold settings, hooks, agents, skills and memory that belong to
 * whoever wrote them. The houston skill reaches a machine through `houston skill install`,
 * from the package, so no copy of it is committed either. Two once were, and `.gitignore`
 * re-included their whole `skills/` folders to keep them -- so every other skill in a clone
 * was one `git add -A` away from GitHub, and only this checkout's own `.git/info/exclude`
 * (which no other clone has) kept them out.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');

const git = (args: string[], cwd = ROOT): string =>
  spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout;

/** Paths an agent tool writes in a checkout, and that must stay there. */
const LOCAL = [
  '.claude/settings.local.json',
  '.claude/skills/houston/SKILL.md',
  '.claude/skills/release/SKILL.md',
  'src/.claude/settings.local.json',
  '.agents/skills/houston/SKILL.md',
  '.agents/skills/other/SKILL.md',
  '.codex/config.toml',
  '.gemini/settings.json',
  '.cursor/rules/a.mdc',
  '.cursorrules',
  '.windsurf/rules.md',
  '.continue/config.json',
  '.aider.conf.yml',
  '.worktrees/topic/package.json',
  '.mcp.json',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'GEMINI.md',
];

describe("an agent tool's local files", () => {
  it('are not tracked', () => {
    expect(git(['ls-files', '--', '.claude', '.agents', ...LOCAL])).toBe('');
  });

  it('are ignored by .gitignore alone, as in a clone that has no local exclude file', () => {
    // A bare repository holding only the committed .gitignore: this checkout's
    // .git/info/exclude and the machine's global excludes file are not consulted.
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-ignore-'));
    try {
      git(['init', '--quiet'], clone);
      fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(clone, '.gitignore'));
      const check = (paths: string[]): string[] =>
        git(['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', ...paths], clone)
          .split('\n')
          .filter(Boolean);
      expect(check(LOCAL)).toEqual(LOCAL);
      // ...and the packaged skill and its template, which are the project's, are not.
      expect(check(['data/skill/SKILL.md', 'tools/skill/SKILL.template.md'])).toEqual([]);
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });
});
