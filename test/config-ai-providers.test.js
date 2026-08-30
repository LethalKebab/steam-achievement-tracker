/**
 * One set of settings per vendor
 * ------------------------------------------------
 * Run with: node --test
 *
 * What this file guards is **one vendor's settings being used as another's**.
 *
 * `ai` used to hold a single `apiKey` / `model` / `baseUrl` while there are three vendors.
 * So "try another one", the most ordinary action there is, had no safe form:
 *
 *  - the settings page made you paste the key again every time (it at least **refuses** to
 *    carry the previous vendor's over, see the `effective` line in `api.js`), while `model`
 *    did not even refuse
 *  - the command line's `--provider` did neither: it flipped the provider and sent the
 *    previous vendor's key straight out
 *
 * **That 401's wording is the most expensive part here**: the error read 「检查
 * ANTHROPIC_API_KEY」 while that variable was plainly set correctly — the real cause being
 * that it was never read at all. An error pointing in the opposite direction costs more time
 * than no error.
 *
 * Which fields go into `ai.providers` was measured rather than chosen: **read by more than
 * one vendor, with a different correct value for each** applies only to `apiKey` / `model` /
 * `baseUrl`. `maxTokens` and `effort` are cross-vendor budgets (the same value is right
 * anywhere); `geminiTools`, `webFetch` and `searchTool` are read by exactly one vendor, so
 * the previous vendor's value is ignored rather than misused.
 *
 * Three rules:
 *
 *  - **an env var is looked up by the vendor being asked for**, not by the one named in
 *    config.json
 *  - **`providers[vendor]` is that vendor's own set**, and they do not overwrite each other
 *  - **the legacy flat fields belong to `ai.provider`'s vendor alone**, and **that
 *    attribution has to happen before any provider override takes effect** — the other way
 *    round hands the previous vendor's key to the new one
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// loadConfig's CONFIG_PATH is module-level and fixed at import time, so TRACKER_DATA_DIR has
// to be set before the **dynamic** import. The whole file shares one temporary directory and
// each case rewrites config.json itself
const DIR = mkdtempSync(join(tmpdir(), 'aiproviders-'));
process.env.TRACKER_DATA_DIR = DIR;
const { resolveAiKey, canonicalAiProvider, switchAiProvider, loadConfig, saveConfig } =
  await import('../lib/config.js');

const writeConfig = (ai) =>
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({ steamApiKey: 'x', steamId: 'y', ai }));

/** Each case brings its own clean fake environment and never reads the real process.env */
const env = (o = {}) => ({ ...o });

// ---------------------------------------------------------------------------
// Normalising vendor names
// ---------------------------------------------------------------------------

describe('canonicalAiProvider', () => {
  test('aliases converge on one vendor — one set per vendor, not per endpoint', () => {
    // google is an alias for gemini (createProvider agrees); deepseek-openai is the same
    // vendor's other endpoint with **the same key**, and splitting them into two sets would
    // only make people paste it twice
    assert.equal(canonicalAiProvider('google'), 'gemini');
    assert.equal(canonicalAiProvider('GEMINI'), 'gemini');
    assert.equal(canonicalAiProvider('deepseek-openai'), 'deepseek');
    assert.equal(canonicalAiProvider('Anthropic'), 'anthropic');
  });

  test('an unrecognised name is returned verbatim rather than guessed', () => {
    // A self-hosted endpoint or a proxy service can be called anything. Guessing wrong means
    // reading an env var that does not exist, which is far harder to trace than "I do not
    // recognise this vendor"
    assert.equal(canonicalAiProvider('my-proxy'), 'my-proxy');
    assert.equal(canonicalAiProvider(''), '');
    assert.equal(canonicalAiProvider(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// Resolving the key
// ---------------------------------------------------------------------------

describe('resolveAiKey', () => {
  test('the env var is looked up by **the vendor being asked for**, not by the one in the config', () => {
    const ai = { provider: 'deepseek', apiKey: 'DS', providers: {} };
    const e = env({ ANTHROPIC_API_KEY: 'ANT', DEEPSEEK_API_KEY: 'DS-ENV' });
    assert.equal(resolveAiKey(ai, 'anthropic', e), 'ANT');
    assert.equal(resolveAiKey(ai, 'deepseek', e), 'DS-ENV');
  });

  test('an env var outranks the file — trying a new key temporarily needs no file edit', () => {
    const ai = { provider: 'anthropic', providers: { anthropic: { apiKey: 'FROM-FILE' } } };
    assert.equal(resolveAiKey(ai, 'anthropic', env({ ANTHROPIC_API_KEY: 'FROM-ENV' })), 'FROM-ENV');
    assert.equal(resolveAiKey(ai, 'anthropic', env()), 'FROM-FILE');
  });

  test('one set per vendor, with no overwriting', () => {
    const ai = {
      provider: 'gemini',
      providers: { anthropic: { apiKey: 'ANT' }, gemini: { apiKey: 'GEM' }, deepseek: { apiKey: 'DS' } },
    };
    assert.equal(resolveAiKey(ai, 'anthropic', env()), 'ANT');
    assert.equal(resolveAiKey(ai, 'gemini', env()), 'GEM');
    assert.equal(resolveAiKey(ai, 'deepseek', env()), 'DS');
    assert.equal(resolveAiKey(ai, 'deepseek-openai', env()), 'DS', 'the same vendor\'s other endpoint shares one key');
  });

  test('the legacy flat apiKey belongs to ai.provider\'s vendor alone', () => {
    // An old config had one slot, and what it held was necessarily that provider's key, so falling back for that vendor is right
    const ai = { provider: 'deepseek', apiKey: 'DS-LEGACY' };
    assert.equal(resolveAiKey(ai, 'deepseek', env()), 'DS-LEGACY', 'an old config has to keep working');
  });

  test('**this is the bug**: the legacy slot must not fall back when another vendor is asked for', () => {
    const ai = { provider: 'deepseek', apiKey: 'DS-LEGACY' };
    assert.equal(
      resolveAiKey(ai, 'anthropic', env()), '',
      'DeepSeek\'s key was sent to Anthropic — and that 401 says 「检查 ANTHROPIC_API_KEY」, pointing the opposite way'
    );
  });

  test('the providers slot outranks legacy — after migrating, the old value no longer applies', () => {
    const ai = { provider: 'anthropic', apiKey: 'OLD', providers: { anthropic: { apiKey: 'NEW' } } };
    assert.equal(resolveAiKey(ai, 'anthropic', env()), 'NEW');
  });

  test('leading and trailing whitespace is always stripped', () => {
    // A newline picked up while copy-pasting is the most common cause of a 401, and the
    // reported error points nowhere near it.
    // All three sources have to strip; missing one makes this protection hold only for some forms
    assert.equal(resolveAiKey({ providers: { gemini: { apiKey: '  G  ' } } }, 'gemini', env()), 'G');
    assert.equal(resolveAiKey({ provider: 'gemini', apiKey: '\tG\n' }, 'gemini', env()), 'G');
    assert.equal(resolveAiKey({}, 'gemini', env({ GEMINI_API_KEY: ' G ' })), 'G');
  });

  test('nothing anywhere is an empty string, not undefined', () => {
    // Callers write `if (!config.ai.apiKey)` everywhere, and returning undefined merely pushes the decision onto them
    assert.equal(resolveAiKey({}, 'anthropic', env()), '');
    assert.equal(resolveAiKey(null, 'anthropic', env()), '');
  });
});

// ---------------------------------------------------------------------------
// Switching vendor: three fields switch together
// ---------------------------------------------------------------------------

describe('switchAiProvider', () => {
  const AI = {
    provider: 'deepseek',
    providers: {
      anthropic: { apiKey: 'ANT', model: 'claude-opus-5' },
      gemini: { apiKey: 'GEM', model: 'gemini-flash-latest' },
      deepseek: { apiKey: 'DS', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/anthropic' },
    },
  };

  test('the key and the model switch together — **switching back finds that vendor\'s own model still there**', () => {
    // This is the entire reason model went into providers. With one `model`, switching vendor
    // could only clear it (carrying the previous vendor's model name across necessarily trips
    // assertModelMatchesProvider), so "the version I pinned for Anthropic" was gone after
    // switching to Gemini and back — with no error, quietly reverting to the default
    const a = switchAiProvider(AI, 'anthropic', env());
    assert.equal(a.apiKey, 'ANT');
    assert.equal(a.model, 'claude-opus-5');

    const g = switchAiProvider(a, 'gemini', env());
    assert.equal(g.apiKey, 'GEM');
    assert.equal(g.model, 'gemini-flash-latest');

    assert.equal(switchAiProvider(g, 'anthropic', env()).model, 'claude-opus-5', 'switching back should find it exactly as it was');
  });

  test('baseUrl travels with it too — it is likewise one value per vendor', () => {
    // baseUrl is read by both anthropic and deepseek, and a DeepSeek compatible-endpoint URL
    // handed to anthropic means sending requests to somebody else's address. Left in the flat
    // layer, it crosses over exactly like that
    assert.equal(switchAiProvider(AI, 'deepseek', env()).baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(switchAiProvider(AI, 'anthropic', env()).baseUrl, '', 'another vendor\'s endpoint address must not be carried over');
  });

  test('an explicitly given model takes precedence', () => {
    assert.equal(switchAiProvider(AI, 'anthropic', env(), { model: 'claude-sonnet-5' }).model, 'claude-sonnet-5');
  });

  test('switching to a vendor with nothing configured leaves all three fields empty — nothing from the previous one', () => {
    const ai = { provider: 'deepseek', apiKey: 'DS', model: 'deepseek-v4-flash', providers: {} };
    const next = switchAiProvider(ai, 'gemini', env());
    assert.equal(next.apiKey, '');
    assert.equal(next.model, '');
    assert.equal(next.baseUrl, '');
  });

  test('the original object is not modified — the caller\'s config must not be changed in place', () => {
    const ai = { provider: 'deepseek', apiKey: 'DS', model: 'm', providers: { anthropic: { apiKey: 'ANT' } } };
    switchAiProvider(ai, 'anthropic', env());
    assert.equal(ai.provider, 'deepseek');
    assert.equal(ai.apiKey, 'DS');
    assert.equal(ai.model, 'm');
  });

  test('the cross-vendor budget knobs are carried across verbatim — they are not one value per vendor', () => {
    const ai = { provider: 'gemini', providers: {}, maxTokens: 12345, effort: 'low', chunkSize: 20 };
    const next = switchAiProvider(ai, 'anthropic', env());
    assert.equal(next.maxTokens, 12345);
    assert.equal(next.effort, 'low');
    assert.equal(next.chunkSize, 20);
  });
});

// ---------------------------------------------------------------------------
// The loadConfig side
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  test('the current vendor\'s three fields are flattened onto ai, so downstream needs not one word changed', () => {
    writeConfig({
      provider: 'gemini',
      providers: { anthropic: { apiKey: 'ANT', model: 'claude-opus-5' }, gemini: { apiKey: 'GEM', model: 'gemini-3-pro' } },
    });
    const { ai } = loadConfig();
    assert.equal(ai.apiKey, 'GEM');
    assert.equal(ai.model, 'gemini-3-pro');
  });

  test('an old config with only the legacy flat fields still works', () => {
    writeConfig({ provider: 'deepseek', apiKey: 'DS-LEGACY', model: 'deepseek-v4-flash' });
    const { ai } = loadConfig();
    assert.equal(ai.apiKey, 'DS-LEGACY');
    assert.equal(ai.model, 'deepseek-v4-flash');
  });

  /**
   * **Attribution has to happen before the AI_PROVIDER override.**
   *
   * The legacy flat slot's owner is **the provider written in the file**, not the one an env
   * var or `--provider` switched to. Overriding first and attributing second recognises the
   * previous vendor's key as the new vendor's — the very bug this change set out to fix,
   * merely growing back in a different place.
   */
  test('when AI_PROVIDER switches vendor, the legacy slot is not recognised as the new one\'s', () => {
    writeConfig({ provider: 'deepseek', apiKey: 'DS-LEGACY', model: 'deepseek-v4-flash' });
    process.env.AI_PROVIDER = 'anthropic';
    try {
      const { ai } = loadConfig();
      assert.equal(ai.provider, 'anthropic');
      assert.equal(ai.apiKey, '', 'DeepSeek\'s key was recognised as Anthropic\'s');
      assert.equal(ai.model, '', 'carrying DeepSeek\'s model name across would trip assertModelMatchesProvider');
    } finally {
      delete process.env.AI_PROVIDER;
    }
  });

  test('AI_PROVIDER switching to a configured vendor takes that vendor\'s own whole set', () => {
    writeConfig({
      provider: 'deepseek',
      apiKey: 'DS-LEGACY',
      providers: { anthropic: { apiKey: 'ANT', model: 'claude-opus-5' } },
    });
    process.env.AI_PROVIDER = 'anthropic';
    try {
      const { ai } = loadConfig();
      assert.equal(ai.apiKey, 'ANT');
      assert.equal(ai.model, 'claude-opus-5');
    } finally {
      delete process.env.AI_PROVIDER;
    }
  });

  test('AI_MODEL outranks the stored model — it is the "which one this time" temporary override', () => {
    writeConfig({ provider: 'gemini', providers: { gemini: { apiKey: 'GEM', model: 'gemini-flash-latest' } } });
    process.env.AI_MODEL = 'gemini-3-pro';
    try {
      assert.equal(loadConfig().ai.model, 'gemini-3-pro');
    } finally {
      delete process.env.AI_MODEL;
    }
  });

  test('ai.providers stays in the config verbatim — the settings page relies on it to know which vendors are configured', () => {
    writeConfig({ provider: 'gemini', providers: { anthropic: { apiKey: 'ANT' }, gemini: { apiKey: 'GEM' } } });
    assert.deepEqual(Object.keys(loadConfig().ai.providers).sort(), ['anthropic', 'gemini']);
  });

  /**
   * **Saving one vendor must not erase another.**
   *
   * This is the one direction in this change set that **loses data silently**: if the settings
   * page writes the whole `providers` back when saving Gemini, Anthropic's set is gone while
   * the page displays 「保存成功」. The user only finds out the next time they switch back, by
   * which point there is no telling when it went.
   *
   * It rests on `saveConfig`'s merge recursing into nested objects. **The fact that it recurses
   * has to be pinned** — switching to a shallow merge turns no existing test red, and the
   * consequence is the paragraph above.
   */
  test('saving one vendor does not erase another', () => {
    writeConfig({
      provider: 'anthropic',
      providers: { anthropic: { apiKey: 'ANT', model: 'claude-opus-5' }, gemini: { apiKey: 'GEM' } },
    });
    saveConfig({ ai: { provider: 'deepseek', providers: { deepseek: { apiKey: 'DS', model: '' } } } });

    const { ai } = loadConfig();
    assert.equal(ai.providers.anthropic.apiKey, 'ANT', 'Anthropic\'s set was erased by the act of saving DeepSeek');
    assert.equal(ai.providers.anthropic.model, 'claude-opus-5', 'the model has to survive along with it');
    assert.equal(ai.providers.gemini.apiKey, 'GEM');
    assert.equal(ai.apiKey, 'DS', 'the current provider\'s key has to resolve');
  });
});
