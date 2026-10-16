// Agentix — the models each agent CLI can run with, for the model picker in "New agent".
// Formats checked on kenz's machine (2026-10-16):
//   codex 0.162.1    `codex debug models` → {"models":[{slug, display_name, description, visibility, priority,
//                    supported_reasoning_levels:[{effort}], default_reasoning_level}]}
//                    (cached in ~/.codex/models_cache.json); default from `model = "..."` in ~/.codex/config.toml
//   opencode 2.0.30  `opencode models` → one provider/model per line (the model part can hold "/" too)
//   pi 1.3.0         `pi --list-models` → table: provider  model  context  max-out  thinking  images
//   claude 2.1.300   no list command; --model takes the aliases fable, opus, sonnet, haiku or a full name
//   hermes 0.22.2    no list command; default from model.default in ~/.hermes/config.yaml
// gemini, aider and goose: no list here, so only the CLI default can be selected.
// Lists are cached for 10 minutes.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelOption } from '../../../shared/src/types.ts';
import { cliPath } from '../settings.ts';

export interface ModelList {
  models: ModelOption[];
  /** the model the CLI uses when none is picked, when we can tell */
  current?: string;
  /** why the list is empty or partial */
  error?: string;
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; list: ModelList }>();

function run(cmd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cliPath(cmd), args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' '))) : resolve(String(stdout)));
  });
}

const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };
const home = () => process.env.HOME || homedir();

export function parseCodexModels(json: string): ModelOption[] {
  const list: any[] = JSON.parse(json)?.models ?? [];
  return list
    .filter(m => m?.slug && m.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map(m => {
      const efforts = (m.supported_reasoning_levels ?? []).map((l: any) => String(l?.effort ?? l)).filter(Boolean);
      return {
        id: String(m.slug),
        ...(m.display_name ? { label: String(m.display_name) } : {}),
        ...(m.description ? { description: String(m.description) } : {}),
        ...(efforts.length ? { efforts } : {}),
        ...(m.default_reasoning_level ? { defaultEffort: String(m.default_reasoning_level) } : {}),
      };
    });
}

export function parseOpencodeModels(text: string): ModelOption[] {
  return text.split('\n').map(l => l.trim()).filter(l => /^[\w.~-]+\/\S+$/.test(l))
    .map(id => ({ id, group: id.slice(0, id.indexOf('/')) }));
}

export function parsePiModels(text: string): ModelOption[] {
  const out: ModelOption[] = [];
  for (const line of text.split('\n')) {
    const [provider, model] = line.trim().split(/\s+/);
    if (!provider || !model || provider === 'provider') continue;
    out.push({ id: `${provider}/${model}`, label: model, group: provider });
  }
  return out;
}

/** The value of `model = "..."` at the top level of a TOML file (before the first [section]). */
export function tomlTopModel(toml: string): string | undefined {
  const top = toml.split(/^\s*\[/m)[0];
  return top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
}

/** model.default in hermes's config.yaml (a two-level lookup, no YAML library needed). */
export function hermesDefaultModel(yaml: string): string | undefined {
  const block = yaml.match(/^model:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1];
  const v = block?.match(/^[ \t]+default:\s*(.+?)\s*$/m)?.[1];
  return v?.replace(/^["']|["']$/g, '') || undefined;
}

const CLAUDE_ALIASES: ModelOption[] = [
  { id: 'fable', label: 'Fable (latest)' }, { id: 'opus', label: 'Opus (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' }, { id: 'haiku', label: 'Haiku (latest)' },
];

const LISTERS: Record<string, () => Promise<ModelList>> = {
  async codex() {
    const toml = read(join(home(), '.codex', 'config.toml')) ?? '';
    const effort = toml.split(/^\s*\[/m)[0].match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
    const model = tomlTopModel(toml);
    const current = model && effort ? `${model}:${effort}` : model;
    try {
      return { models: parseCodexModels(await run('codex', ['debug', 'models'])), ...(current ? { current } : {}) };
    } catch (err) {
      const cached = read(join(home(), '.codex', 'models_cache.json'));
      if (cached) return { models: parseCodexModels(cached), ...(current ? { current } : {}) };
      throw err;
    }
  },
  async opencode() { return { models: parseOpencodeModels(await run('opencode', ['models'])) }; },
  async pi() { return { models: parsePiModels(await run('pi', ['--list-models'])) }; },
  async claude() { return { models: CLAUDE_ALIASES }; },
  async hermes() {
    const current = hermesDefaultModel(read(join(home(), '.hermes', 'config.yaml')) ?? '');
    return { models: current ? [{ id: current, label: `${current} (configured default)` }] : [], ...(current ? { current } : {}) };
  },
};

/** Models for one CLI kind; an empty list means only the CLI default is available. */
export async function listModels(kind: string, refresh = false): Promise<ModelList> {
  const hit = cache.get(kind);
  if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return hit.list;
  const lister = LISTERS[kind];
  let list: ModelList;
  try {
    list = lister
      ? await lister()
      : { models: [], error: `${kind} does not expose an available model list; use the CLI default` };
  } catch (err) {
    list = { models: [], error: `Could not list ${kind} models: ${(err as Error).message}` };
  }
  if (!list.error) cache.set(kind, { at: Date.now(), list });
  return list;
}

/** Return an error when a non-default model is not in the CLI's available list. */
export async function unavailableModelError(kind: string, model: string): Promise<string | undefined> {
  const list = await listModels(kind);
  if (list.error) return `${list.error}. Model "${model}" cannot be selected.`;
  if (!list.models.length) return `${kind} does not expose an available model list; use the CLI default instead`;
  if (list.models.some(option => option.id === model)) return undefined;

  // Codex encodes the selected reasoning level as model:effort in the stored value.
  const separator = model.lastIndexOf(':');
  if (separator > 0) {
    const base = list.models.find(option => option.id === model.slice(0, separator));
    if (base?.efforts?.includes(model.slice(separator + 1))) return undefined;
  }
  return `Model "${model}" is not in ${kind}'s available model list.`;
}
