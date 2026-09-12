/**
 * score-backup.js —— 模型评分数据的文件级备份与恢复（变更 score-picker-and-backup）。
 *
 * 职责边界（铁律）：
 *   - 只读写评分域自身的五张表（score_criterion_groups / score_criteria / score_model_groups /
 *     score_models / score_values），与 usage_* / cost_* / quota_* / plan_* / map_* / 费用模板零关系；
 *     导出是纯读、恢复是评分域内整体替换，绝不触发数据源重建或汇总层写入。
 *   - 本模块是评分域唯一的文件系统出入口；`src/score.js` 保持纯 DB 域（不引入 node:fs）。
 *
 * 与费用模板备份（src/model-templates.js + 能力 model-price-backup）的关系：
 *   **只对齐风格、不共用代码**——命名与时间戳形态、kind / version / exportedAt / exportedAtMs 字段、
 *   「不可解析的文件永不自动删除」等约定一致；但语义已分叉（模板=按组分文件 / 每组 3 份 / 扫描并集合并 /
 *   启动自动加载 / 新者胜；评分=单文件全量 / 全局 5 份 / 选定一份整体替换 / 不自动加载），
 *   强行抽象会变成参数开关大全，故各自实现。
 *
 * 备份文件（UTF-8 JSON，自包含，可单独拷到另一台机器恢复）：
 *   { kind, version, exportedAt, exportedAtMs, counts, data: { criterionGroups, criteria, modelGroups, models, values } }
 *   文件名：model-rate-score-<YYYYMMDD-HHmmss>-<两位序号>.json
 */

import { runInTransaction, dataDir } from './store.js';
import { loadScoreboard, scoreStats } from './score.js';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

export const BACKUP_KIND = 'model-rate-score';
export const BACKUP_VERSION = 1;
/** 目录内滚动保留的备份份数（全局，不分组） */
export const BACKUP_KEEP = 5;
/** 本工具备份文件名格式：model-rate-score-20260911-223000-00.json */
const BACKUP_FILE_RE = /^model-rate-score-\d{8}-\d{6}-\d{2}\.json$/;

const pad2 = (n) => String(n).padStart(2, '0');

/** 备份文件名时间戳（YYYYMMDD-HHmmss，同秒按两位序号排先后，风格对齐 model-templates 的 backupStamp） */
function backupStamp(now) {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

/** 备份目录默认位置：<运行数据根目录>/model-rate-score（测试可通过参数注入临时目录） */
export function scoreBackupDir(envOverride = process.env) {
  return join(dataDir(envOverride), 'model-rate-score');
}

/* ================= 序列化 / 规整 ================= */

/** 整包 scores（{modelId:{criterionId:value}}）→ 扁平分值与引用数组（按模型序 → 标准序，输出稳定可 diff） */
function flattenScores(board) {
  const out = [];
  board.models.forEach((m) => {
    const row = board.scores[m.id];
    if (!row) return;
    board.criteria.forEach((c) => {
      const v = row[c.id];
      if (v === undefined) return;                       // 缺行 = 未评分，不写 0
      out.push({ modelId: m.id, criterionId: c.id, value: v });
    });
  });
  return out;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

/** 取一个有限数字，非法时回落到 fallback（排序序号不是引用关系，缺失不应阻断恢复） */
function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ================= 导出 ================= */

/**
 * 全量导出：把当前全部评分标准、模型与其分值配置写入备份目录的单个 JSON 文件。
 * 纯读库 + 写目录：不开写事务、不改库内任何一行；写后按 BACKUP_KEEP 滚动清理。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dir 备份目录（默认 <数据根目录>/model-rate-score，不存在则创建）
 * @returns {{file: string, dir: string, exportedAt: string, exportedAtMs: number, counts: object}}
 */
export function exportScoreBackup(db, dir = scoreBackupDir()) {
  const board = loadScoreboard(db);
  const values = flattenScores(board);
  const now = new Date();
  const payload = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    exportedAtMs: now.getTime(),
    counts: {
      criterionGroups: board.criterionGroups.length,
      criteria: board.criteria.length,
      modelGroups: board.modelGroups.length,
      models: board.models.length,
      values: values.length,
    },
    data: {
      // 注意字段名换算：整包用 desc / order（面向面板），备份用 description / sortOrder（对齐 DB 列名）
      criterionGroups: board.criterionGroups.map((g) => ({ id: g.id, name: g.name, sortOrder: g.order })),
      criteria: board.criteria.map((c) => ({
        id: c.id, groupId: c.groupId, name: c.name, unit: c.unit,
        description: c.desc ?? '', sortOrder: c.order,
      })),
      modelGroups: board.modelGroups.map((g) => ({ id: g.id, name: g.name, sortOrder: g.order })),
      models: board.models.map((m) => ({ id: m.id, groupId: m.groupId, name: m.name, sortOrder: m.order })),
      values,
    },
  };

  mkdirSync(dir, { recursive: true });
  const stamp = backupStamp(now);
  let fileName;
  for (let seq = 0; ; seq += 1) {
    fileName = `model-rate-score-${stamp}-${pad2(seq)}.json`;
    if (!existsSync(join(dir, fileName))) break;
  }
  writeFileSync(join(dir, fileName), JSON.stringify(payload, null, 2), 'utf8');
  pruneBackups(dir);
  return { file: fileName, dir, exportedAt: payload.exportedAt, exportedAtMs: payload.exportedAtMs, counts: payload.counts };
}

/**
 * 滚动清理：只有「**命名匹配本工具格式** 且 **能被识别为可用备份**」的文件才参与滚动——
 * 按文件名字典序（= 时间序）排序，保留最新 BACKUP_KEEP 份并删除更旧的。
 * 命名不匹配、或内容不可解析 / kind 不符 / 版本不兼容的文件**一律不动**：
 * 它们归不到本工具的滚动集合里，删掉只会丢失用户文件与排障线索（列表里仍会灰显提示原因）。
 */
function pruneBackups(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;                                              // 目录不可读：静默
  }
  const candidates = names.filter((f) => {
    if (!BACKUP_FILE_RE.test(f)) return false;
    try {
      return checkFileShape(JSON.parse(readFileSync(join(dir, f), 'utf8'))).ok;
    } catch {
      return false;                                      // 坏文件：不参与自动删除
    }
  });
  const sorted = candidates.sort();
  while (sorted.length > BACKUP_KEEP) unlinkSync(join(dir, sorted.shift()));
}

/* ================= 校验 ================= */

/** 文件级校验（列表与恢复共用）：kind / version / data 结构 / 导出时间戳 */
function checkFileShape(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: '不是本工具的评分备份文件' };
  }
  if (payload.kind !== BACKUP_KIND) {
    return { ok: false, reason: '不是本工具的评分备份文件' };
  }
  if (payload.version !== BACKUP_VERSION) {
    return { ok: false, reason: `备份格式版本不兼容（文件 v${payload.version}，当前支持 v${BACKUP_VERSION}）` };
  }
  const d = payload.data;
  const shaped = d && typeof d === 'object' &&
    Array.isArray(d.criterionGroups) && Array.isArray(d.criteria) &&
    Array.isArray(d.modelGroups) && Array.isArray(d.models) && Array.isArray(d.values);
  if (!shaped) return { ok: false, reason: '备份内容结构不完整' };
  if (!Number.isFinite(payload.exportedAtMs) || payload.exportedAtMs <= 0) {
    return { ok: false, reason: '备份内容结构不完整' };
  }
  return { ok: true };
}

/**
 * 内容级校验（仅恢复用）：先全校验、后写库，任何一条不合格即抛错（库内不留半截）。
 * 校验项：id / 名称非空且组内唯一、unit 取值、分组引用存在、分值引用存在且不重复、分值取值范围。
 * @returns 规整后的五组数据
 */
function normalizeBackupData(payload) {
  const shape = checkFileShape(payload);
  if (!shape.ok) throw new Error(shape.reason);
  const d = payload.data;

  const takeIds = (list, label) => {
    const ids = new Set();
    const out = [];
    asArray(list).forEach((raw, i) => {
      const id = String(raw?.id ?? '').trim();
      if (!id) throw new Error(`${label}第 ${i + 1} 条缺少 id`);
      if (ids.has(id)) throw new Error(`${label}的 id 重复：${id}`);
      ids.add(id);
      out.push({ raw, id, index: i });
    });
    return { ids, out };
  };
  const takeNames = (list, label) => {
    const names = new Set();
    asArray(list).forEach((raw) => {
      const nm = String(raw?.name ?? '').trim();
      if (!nm) throw new Error(`${label}存在空名称`);
      if (names.has(nm)) throw new Error(`${label}的名称重复：${nm}`);
      names.add(nm);
    });
  };

  const cg = takeIds(d.criterionGroups, '评分标准分组');
  takeNames(d.criterionGroups, '评分标准分组');
  const mg = takeIds(d.modelGroups, '模型分组');
  takeNames(d.modelGroups, '模型分组');
  const cs = takeIds(d.criteria, '评分标准');
  takeNames(d.criteria, '评分标准');
  const ms = takeIds(d.models, '模型');
  takeNames(d.models, '模型');

  const criterionGroups = cg.out.map(({ raw, id, index }) => ({
    id, name: String(raw.name).trim(), sortOrder: numOr(raw.sortOrder, index + 1),
  }));
  const modelGroups = mg.out.map(({ raw, id, index }) => ({
    id, name: String(raw.name).trim(), sortOrder: numOr(raw.sortOrder, index + 1),
  }));
  const criteria = cs.out.map(({ raw, id, index }) => {
    const groupId = String(raw?.groupId ?? '').trim();
    if (!cg.ids.has(groupId)) throw new Error(`评分标准「${String(raw?.name ?? id)}」引用了不存在的分组`);
    if (raw?.unit !== 'pct' && raw?.unit !== 'num') {
      throw new Error(`评分标准「${String(raw?.name ?? id)}」的单位无效（应为 pct 或 num）`);
    }
    return {
      id, groupId, name: String(raw.name).trim(), unit: raw.unit,
      description: String(raw?.description ?? ''), sortOrder: numOr(raw.sortOrder, index + 1),
    };
  });
  const models = ms.out.map(({ raw, id, index }) => {
    const groupId = String(raw?.groupId ?? '').trim();
    if (!mg.ids.has(groupId)) throw new Error(`模型「${String(raw?.name ?? id)}」引用了不存在的分组`);
    return { id, groupId, name: String(raw.name).trim(), sortOrder: numOr(raw.sortOrder, index + 1) };
  });

  const unitOf = new Map(criteria.map((c) => [c.id, c.unit]));
  const seenPair = new Set();
  const values = asArray(d.values).map((raw, i) => {
    const modelId = String(raw?.modelId ?? '').trim();
    const criterionId = String(raw?.criterionId ?? '').trim();
    if (!ms.ids.has(modelId)) throw new Error(`第 ${i + 1} 条分值引用了不存在的模型`);
    if (!unitOf.has(criterionId)) throw new Error(`第 ${i + 1} 条分值引用了不存在的评分标准`);
    const pair = modelId + '\u0000' + criterionId;
    if (seenPair.has(pair)) throw new Error('同一个模型与同一条评分标准出现了重复分值');
    seenPair.add(pair);
    const v = Number(raw?.value);
    if (!Number.isFinite(v)) throw new Error('存在不是数字的分值');
    if (v < 0) throw new Error('存在负数分值');
    if (unitOf.get(criterionId) === 'pct' && v > 100) throw new Error('存在超过 100 的百分比分值');
    return { modelId, criterionId, value: v };
  });

  return { criterionGroups, criteria, modelGroups, models, values };
}

/* ================= 列表 ================= */

/**
 * 列出备份目录中的全部 .json：可识别的返回 valid:true + 备份时间 + 规模摘要；
 * 不可识别的返回 valid:false + reason（不可用于恢复，也永不被滚动删除）。
 * 排序：可用项按备份时间由新到旧，不可用项按文件名字典序排在后面。
 * 目录不存在时返回空列表（不创建目录、不报错）。
 * @returns {{dir: string, files: Array}}
 */
export function listScoreBackups(dir = scoreBackupDir()) {
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { dir, files: [] };
  }
  const usable = [];
  const broken = [];
  names.forEach((file) => {
    let payload;
    try {
      payload = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      broken.push({ file, valid: false, reason: '不是合法的 JSON 文件' });
      return;
    }
    const shape = checkFileShape(payload);
    if (!shape.ok) {
      broken.push({ file, valid: false, reason: shape.reason });
      return;
    }
    const c = payload.counts && typeof payload.counts === 'object' ? payload.counts : {};
    const d = payload.data;
    usable.push({
      file,
      valid: true,
      exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : '',
      exportedAtMs: payload.exportedAtMs,
      counts: {
        criterionGroups: numOr(c.criterionGroups, d.criterionGroups.length),
        criteria: numOr(c.criteria, d.criteria.length),
        modelGroups: numOr(c.modelGroups, d.modelGroups.length),
        models: numOr(c.models, d.models.length),
        values: numOr(c.values, d.values.length),
      },
    });
  });
  usable.sort((a, b) => b.exportedAtMs - a.exportedAtMs);
  broken.sort((a, b) => a.file.localeCompare(b.file));
  return { dir, files: usable.concat(broken) };
}

/* ================= 恢复 ================= */

/**
 * 选定一份备份恢复：**整体替换**——清空五张表后写入备份内容，单事务，失败整体回滚。
 * 校验（文件名白名单 + 内容级全量校验）全部在写库之前完成，库内数据在校验失败时保持原样。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} file 备份文件名（只接受目录内的文件名，含路径分隔符或 .. 一律拒绝）
 * @param {string} dir 备份目录
 * @returns {{ok: true, stats: object, restoredFrom: string, exportedAt: string, exportedAtMs: number}}
 */
export function restoreScoreBackup(db, file, dir = scoreBackupDir()) {
  const name = String(file ?? '').trim();
  if (!name || name !== basename(name) || !name.endsWith('.json')) {
    throw new Error('备份文件名不合法');
  }
  const hit = listScoreBackups(dir).files.find((f) => f.file === name && f.valid);
  if (!hit) throw new Error('找不到该备份文件（或它不是本工具可用的评分备份）');

  let payload;
  try {
    payload = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch (error) {
    throw new Error('备份文件读取失败：' + (error?.message || error));
  }
  const data = normalizeBackupData(payload);

  runInTransaction(db, () => {
    // 先清空（子表在前，满足外键），再按组 → 条目顺序写入
    db.exec(
      'DELETE FROM score_values; DELETE FROM score_criteria; DELETE FROM score_criterion_groups; ' +
      'DELETE FROM score_models; DELETE FROM score_model_groups;'
    );
    const cgIns = db.prepare('INSERT INTO score_criterion_groups (id, name, sort_order) VALUES (?, ?, ?)');
    data.criterionGroups.forEach((g) => cgIns.run(g.id, g.name, g.sortOrder));
    const mgIns = db.prepare('INSERT INTO score_model_groups (id, name, sort_order) VALUES (?, ?, ?)');
    data.modelGroups.forEach((g) => mgIns.run(g.id, g.name, g.sortOrder));
    const cIns = db.prepare(
      'INSERT INTO score_criteria (id, group_id, name, unit, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    );
    data.criteria.forEach((c) => cIns.run(c.id, c.groupId, c.name, c.unit, c.description, c.sortOrder));
    const mIns = db.prepare('INSERT INTO score_models (id, group_id, name, sort_order) VALUES (?, ?, ?, ?)');
    data.models.forEach((m) => mIns.run(m.id, m.groupId, m.name, m.sortOrder));
    const vIns = db.prepare('INSERT INTO score_values (model_id, criterion_id, value) VALUES (?, ?, ?)');
    data.values.forEach((v) => vIns.run(v.modelId, v.criterionId, v.value));
  });

  return {
    ok: true,
    stats: scoreStats(db),
    restoredFrom: name,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : '',
    exportedAtMs: payload.exportedAtMs,
  };
}
