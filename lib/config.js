/**
 * 配置读写
 * ------------------------------------------------
 * 敏感信息存在项目根目录的 config.json 里(已在 .gitignore),不写进源码。
 * 环境变量优先级更高,方便临时覆盖:STEAM_API_KEY / STEAM_ID / NOTION_TOKEN。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = join(ROOT, 'config.json');

const DEFAULTS = {
  steamApiKey: '',
  steamId: '',
  // 语言:影响 Steam 返回的游戏名和成就名
  language: 'schinese',
  port: 8777,
  // serve 启动时数据超过这个小时数就自动后台同步一次(设 0 表示从不自动同步)
  syncStaleHours: 12,
  // serve 启动时顺带发现一次新攻略页(Notion + 本地 guides/)。设 false 关掉
  syncGuidesOnServe: true,
  // 每次 Steam API 调用之间的间隔,防限流。被限流(429)多的话往上调
  requestDelayMs: 300,
  // --- 打开 Dashboard 时那次自动同步的取样(CLI 的 `sync` 不受影响,那个永远全量)---
  // 每次自动同步顺带复查多少款"没玩过但也该确认一下"的游戏。0 = 关掉轮换扫描
  // (关掉的话,开发者给游戏加了新成就就只能等你下次玩它才会发现)
  sweepBudget: 40,
  // 一款游戏最多多久没跟 Steam 对过账。超过就排进轮换扫描队列
  maxStatsAgeDays: 7,
  // 完美游戏(100%)用更短的:成就总数变多会让它掉出 100%,这个最想早点知道
  perfectGameMaxAgeDays: 3,
  dbPath: 'data/steam.db',
  guidesDir: 'guides',
  notion: {
    token: '',
    // 存放攻略页面的 Notion 数据库 ID(打开那个数据库,URL 里 32 位十六进制那段)
    overviewDbId: '',
  },
};

/** 深合并:只合并普通对象,数组/标量直接覆盖 */
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig({ required = [] } = {}) {
  let onDisk = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`config.json 不是合法 JSON:${err.message}`);
    }
  }

  const cfg = merge(DEFAULTS, onDisk);
  if (process.env.STEAM_API_KEY) cfg.steamApiKey = process.env.STEAM_API_KEY;
  if (process.env.STEAM_ID) cfg.steamId = process.env.STEAM_ID;
  if (process.env.NOTION_TOKEN) cfg.notion.token = process.env.NOTION_TOKEN;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);

  cfg.dbPath = join(ROOT, cfg.dbPath);
  cfg.guidesDir = join(ROOT, cfg.guidesDir);

  for (const field of required) {
    const missing =
      (field === 'steam' && (!cfg.steamApiKey || !cfg.steamId)) ||
      (field === 'notion' && !cfg.notion.token);
    if (missing) throw new Error(HINTS[field]);
  }
  return cfg;
}

const HINTS = {
  steam:
    'Steam 凭据没配置。跑一次 `node tracker.js init` 填进去,或者临时用环境变量:\n' +
    '  STEAM_API_KEY=<https://steamcommunity.com/dev/apikey 拿到的 key>\n' +
    '  STEAM_ID=<https://steamid.io 查到的 SteamID64>',
  notion:
    'NOTION_TOKEN 没配置。在 config.json 的 notion.token 里填上你的 Notion Internal Integration secret\n' +
    '(或者用环境变量 NOTION_TOKEN=...),并且把攻略页面/它们的父页面加到该 integration 的 connections 里。',
};

export function saveConfig(patch) {
  const onDisk = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const next = merge(onDisk, patch);
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}
