// Agentix — a git worktree and branch per worker, so workers in the same repo never overwrite each other.
//
// A worker started inside a git repository works in $AGENTIX_HOME/worktrees/<agentId> on its own branch
// (agentix/<name>-<id>), starting from the repo's current commit. Its changes show up as a diff in the
// dashboard; Merge commits them on the branch and merges the branch into the repo's checked-out branch,
// Discard resets the worktree. Removing the worker commits any leftover work to its branch (nothing is
// lost) and deletes the worktree folder.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { Worktree } from '../../shared/src/types.ts';
import { AGENTIX_HOME } from './store.ts';

const IDENT = ['-c', 'user.name=Agentix', '-c', 'user.email=agentix@localhost'];
const MAX_DIFF = 200_000;

export class GitError extends Error {}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    }).replace(/\n$/, '');
  } catch (err: any) {
    throw new GitError(String(err?.stderr || err?.message || err).trim().split('\n').slice(-3).join(' '));
  }
}

const tryGit = (cwd: string, args: string[]) => { try { return git(cwd, args); } catch { return undefined; } };

export const worktreesDir = () => join(AGENTIX_HOME, 'worktrees');

/** Top level of the git repository containing `dir`, if it is one with at least one commit (and not a worktree of ours). */
export function repoRoot(dir: string): string | undefined {
  const root = tryGit(dir, ['rev-parse', '--show-toplevel']);
  if (!root || !tryGit(root, ['rev-parse', '--verify', 'HEAD'])) return undefined;
  const ours = realpath(worktreesDir());
  if (realpath(root).startsWith(ours)) return undefined;
  return root;
}

function realpath(p: string): string { try { return realpathSync(p); } catch { return p; } }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'agent';

/** Give a new worker its own worktree when `cwd` is inside a repo; returns the worktree and the cwd inside it. */
export function createWorktree(cwd: string, agentId: string, name: string): { worktree: Worktree; cwd: string } | undefined {
  const repo = repoRoot(cwd);
  if (!repo) return undefined;
  const base = git(repo, ['rev-parse', 'HEAD']);
  const branch = `agentix/${slug(name)}-${agentId}`;
  const path = join(worktreesDir(), agentId);
  mkdirSync(worktreesDir(), { recursive: true });
  git(repo, ['worktree', 'add', '-b', branch, path, base]);
  const rel = relative(realpath(repo), realpath(cwd));
  const inner = rel && !rel.startsWith('..') && !isAbsolute(rel) ? join(path, rel) : path;
  mkdirSync(inner, { recursive: true });
  return { worktree: { repo, path, branch, base }, cwd: inner };
}

export interface WorktreeStatus {
  branch: string;
  repo: string;
  path: string;
  /** branch checked out in the repo, which Merge merges into */
  target: string;
  files: { status: string; path: string }[];
  /** commits on the branch since `base` */
  commits: number;
  stat: string;
  diff: string;
  truncated: boolean;
}

/**
 * Run git with a throw-away copy of the index, so looking at a worktree never changes the
 * repository's own index. (A plain `git add --intent-to-add` would leave the user's checkout
 * with new files marked as staged, just because someone opened the diff view.)
 */
function withTempIndex<T>(cwd: string, fn: (env: NodeJS.ProcessEnv) => T): T {
  const found = tryGit(cwd, ['rev-parse', '--git-path', 'index']);
  const source = found ? (isAbsolute(found) ? found : join(cwd, found)) : '';
  const temp = join(tmpdir(), `agentix-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    try { if (source) copyFileSync(source, temp); else writeFileSync(temp, ''); }
    catch { writeFileSync(temp, ''); }
    return fn({ GIT_INDEX_FILE: temp });
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

/** Everything the worker changed since `base`: committed and not, new files included. */
export function worktreeStatus(wt: Worktree): WorktreeStatus {
  return withTempIndex(wt.path, (env) => {
    git(wt.path, ['add', '-A', '--intent-to-add'], env);
    const files = git(wt.path, ['diff', '--name-status', wt.base], env).split('\n').filter(Boolean).map(l => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], path: rest.at(-1)! };
    });
    const diff = git(wt.path, ['diff', wt.base], env);
    return {
      branch: wt.branch, repo: wt.repo, path: wt.path,
      target: tryGit(wt.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '?',
      files,
      commits: Number(git(wt.path, ['rev-list', '--count', `${wt.base}..HEAD`])) || 0,
      stat: git(wt.path, ['diff', '--stat', wt.base], env),
      diff: diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) : diff,
      truncated: diff.length > MAX_DIFF,
    };
  });
}

/** Commit everything in the worktree on its branch; false when there was nothing to commit. */
export function commitAll(wt: Worktree, message: string): boolean {
  git(wt.path, ['add', '-A']);
  if (tryGit(wt.path, ['diff', '--cached', '--quiet']) !== undefined) return false; // exit 0: nothing staged
  git(wt.path, [...IDENT, 'commit', '-q', '--no-verify', '-m', message]);
  return true;
}

/**
 * Commit the worker's changes and merge its branch into whatever the repo has checked out.
 * Returns the worktree with `base` moved to the merged commit, so later diffs show only new work.
 */
export function mergeWorktree(wt: Worktree, name: string): { worktree: Worktree; merged: string; into: string } {
  commitAll(wt, `${name}: work from Agentix`);
  const head = git(wt.path, ['rev-parse', 'HEAD']);
  if (head === wt.base) throw new GitError('nothing to merge: no changes since the last merge');
  const into = git(wt.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  try {
    git(wt.repo, [...IDENT, 'merge', '--no-ff', '--no-edit', '-m', `Merge ${wt.branch} (${name}, Agentix)`, wt.branch]);
  } catch (err) {
    tryGit(wt.repo, ['merge', '--abort']);
    throw new GitError(`merge into ${into} failed, nothing changed: ${(err as Error).message}`);
  }
  return { worktree: { ...wt, base: head }, merged: head, into };
}

/** Throw away everything since `base`: commits on the branch and uncommitted files. */
export function discardWorktree(wt: Worktree): void {
  git(wt.path, ['reset', '-q', '--hard', wt.base]);
  git(wt.path, ['clean', '-q', '-fd']);
}

/**
 * The worker was removed: keep its work as commits on its branch, delete the worktree folder,
 * and delete the branch only if it holds nothing new. Returns whether the branch was kept.
 */
export function removeWorktree(wt: Worktree, name: string): boolean {
  let kept = false;
  try {
    commitAll(wt, `${name}: unmerged work (agent removed)`);
    kept = git(wt.path, ['rev-parse', 'HEAD']) !== wt.base;
  } catch { /* worktree already gone */ }
  tryGit(wt.repo, ['worktree', 'remove', '--force', wt.path]);
  tryGit(wt.repo, ['worktree', 'prune']);
  if (!kept) tryGit(wt.repo, ['branch', '-D', wt.branch]);
  return kept;
}
