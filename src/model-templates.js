/**
 * 费用模板（变更 cost-templates-and-weekday-pricing）。
 * 按自由名称维护一组与套餐模型直调费用完全同构的价格配置（K/M 单位、非分段三组价、
 * 分段计价时段行含剩余时段与区分星期），供套餐设置的模型费用行一键导入。
 * - 纯独立配置：不读写映射 / 套餐 / usage_* / cost_* / quota_* 任何表，无外键关联；
 *   删除映射或套餐条目不影响模板（spec: 模板存储与独立性）。
 * - 校验与套餐共用同一份函数（plan.js 导出的 parseHHMM / normalizeTier / toNonNegativeNumber），
 *   保证「与套餐模型费用完全同构」由同一份代码实现而非两处拷贝。
 * - 保存为单事务整组替换（存在则时段行先删后插，风格对齐 savePlanConfig）；
 *   新建草稿以 expectNew 标记——同名模板已存在时拒绝（防止新建静默覆盖既有模板）。
 */

import { runInTransaction, dataDir } from './store.js';
import { toNonNegativeNumber, normalizeTier } from './plan.js';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 备份目录默认位置（<运行数据根目录>/model-price，导入 / 导出 / 启动自动加载共用） */
export function modelPriceDir() {
  return join(dataDir(), 'model-price');
}

/**
 * Web 启动自动加载入口（daemon.runServe 用，spec: 启动自动加载）：
 * 静默语义收口——目录缺失 / 坏文件 / 任何异常都只记日志不抛出，不阻断服务启动。
 * @returns {object|null} 导入摘要（目录不可读等异常时为 null）
 */
export function autoloadModelTemplates(db, dir = modelPriceDir()) {
  try {
    const summary = importTemplatesFromDir(db, dir);
    if (summary.imported > 0) {
      console.log(`[模板备份] 启动自动加载 ${summary.imported} 个模板（目录 ${dir}）`);
    }
    return summary;
  } catch (error) {
    console.error(`[模板备份自动加载失败] ${error?.message || error}`);
    return null;
  }
}

/** 组名归一：trim；空白 → NULL（= 默认组）；超 50 字符拒绝（导入侧由调用方按模板级跳过） */
function normalizeGroupName(raw) {
  const g = String(raw ?? '').trim();
  if (g.length > 50) throw new Error('组名最长 50 个字符');
  return g || null;
}

/** 写入一个模板的时段行（保存与导入共用同一段落库实现，不得复制副本） */
function insertTiers(db, id, tiers) {
  const ins = db.prepare(
    `INSERT INTO model_cost_template_tiers (template_id, sort, start_min, end_min, is_rest, weekdays, input_hit, input_miss, output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of tiers) {
    ins.run(id, t.sort, t.startMin, t.endMin, t.isRest, t.weekdays, t.inputHit, t.inputMiss, t.output);
  }
}

/** 规范化 + 校验一条模板价格配置（与套餐 normalizePrice 同构：分段 / 区分星期 / rest 互斥规则一致；
 *  时段行经 normalizeTier → normalizeTierCore 共享核心校验，铁律：不得复制副本） */
function normalizeTemplatePrice(raw, name) {
  const label = `模板「${name}」`;
  const unit = raw?.unit;
  if (unit !== 'K' && unit !== 'M') throw new Error(`${label}的计价单位无效（应为 K 或 M）`);
  if (raw?.tiered) {
    const rawTiers = Array.isArray(raw?.tiers) ? raw.tiers : [];
    if (rawTiers.length === 0) {
      throw new Error(`${label}已开启分段计价，请至少保留一行时段价格`);
    }
    const byWeekday = raw?.byWeekday ? 1 : 0;
    const tiers = rawTiers.map((t, i) => normalizeTier(t, i, label, { byWeekday: byWeekday === 1 }));
    const rests = tiers.filter((t) => t.isRest);
    if (!byWeekday && rests.length > 1) {
      throw new Error(`${label}最多一行剩余时段，请把多余行改为填写具体时间段`);
    }
    if (byWeekday) {
      const seen = new Set();
      for (const t of rests) {
        if (seen.has(t.weekdays)) {
          throw new Error(`${label}相同星期配置下剩余时段行只能有一行，请合并或调整星期勾选`);
        }
        seen.add(t.weekdays);
      }
    }
    return {
      unit, tiered: 1, byWeekday,
      inputHit: tiers[0].inputHit, inputMiss: tiers[0].inputMiss, output: tiers[0].output,
      tiers
    };
  }
  const inputHit = toNonNegativeNumber(raw?.inputHit);
  if (inputHit === null) throw new Error(`${label}的输入价格·缓存命中须为非负数值`);
  const inputMiss = toNonNegativeNumber(raw?.inputMiss);
  if (inputMiss === null) throw new Error(`${label}的输入价格·未命中须为非负数值`);
  const output = toNonNegativeNumber(raw?.output);
  if (output === null) throw new Error(`${label}的输出价格须为非负数值`);
  return { unit, inputHit, inputMiss, output, tiered: 0, byWeekday: 0 };
}

/**
 * 全部模板（配置量极小，每次请求实时读，不落缓存）。
 * @returns {{templates: Array<{name, unit, tiered, byWeekday, inputHit, inputMiss, output,
 *           group, sortOrder, tiers?}>}}
 *   与 loadPlanConfigs 的 prices 项同构（模型名槽位换为模板名）；tiers 按 sort 升序；
 *   group 为归一后的组名（'' = 默认组）；列表按持久显示顺序（sort_order, rowid）排列。
 */
export function loadModelTemplates(db) {
  const templates = db.prepare(
    `SELECT name, unit, tiered, by_weekday AS byWeekday,
            input_hit AS inputHit, input_miss AS inputMiss, output,
            sort_order AS sortOrder, COALESCE(group_name, '') AS "group"
     FROM model_cost_templates ORDER BY sort_order, rowid`
  ).all();
  const tierStmt = db.prepare(
    `SELECT sort, start_min AS startMin, end_min AS endMin, is_rest AS isRest, weekdays,
            input_hit AS inputHit, input_miss AS inputMiss, output
     FROM model_cost_template_tiers WHERE template_id = ? ORDER BY sort`
  );
  const idStmt = db.prepare('SELECT id FROM model_cost_templates WHERE name = ?');
  for (const t of templates) {
    if (t.tiered) t.tiers = tierStmt.all(idStmt.get(t.name).id);
  }
  return { templates };
}

/**
 * 按模板名整条保存（单事务：存在则价格主行 UPDATE + 时段行 DELETE+INSERT，不存在则新建）。
 * @param {object} body
 *   - name: 模板名（非空，去空白；新建时同名已存在且 expectNew 为 true 则拒绝）
 *   - expectNew: 新建草稿提交时为 true——同名模板已存在时拒绝（防止静默覆盖）
 *   - unit / tiered / byWeekday / inputHit / inputMiss / output / tiers?: 与套餐价格条目同构
 *   - group?: 组名（可空 = 默认组）。编辑路径未携带时保留原组（编辑器草稿不含组字段，防抹掉已设组）
 * @returns {object} 保存后的模板（与 loadModelTemplates 的项同构）
 * @throws {Error} 校验失败（中文提示）
 */
export function saveModelTemplate(db, body) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new Error('请填写模板名');
  const group = body?.group !== undefined ? normalizeGroupName(body.group) : undefined;

  return runInTransaction(db, () => {
    const price = normalizeTemplatePrice(body, name);
    const existing = db.prepare('SELECT id FROM model_cost_templates WHERE name = ?').get(name);
    let id;
    if (existing) {
      if (body?.expectNew) {
        throw new Error(`模板「${name}」已存在，请换一个名字，或从列表中选择它进行编辑`);
      }
      id = existing.id;
      // 编辑不动排序（spec: 模板条目列表排序——保存不动位置），仅价格 + 更新时间；
      // 组仅在显式携带时更新（编辑器草稿不含组字段）
      db.prepare(
        'UPDATE model_cost_templates SET unit = ?, tiered = ?, by_weekday = ?, input_hit = ?, input_miss = ?, output = ?, updated_at_ms = ? WHERE id = ?'
      ).run(price.unit, price.tiered, price.byWeekday, price.inputHit, price.inputMiss, price.output, Date.now(), id);
      if (group !== undefined) {
        db.prepare('UPDATE model_cost_templates SET group_name = ? WHERE id = ?').run(group, id);
      }
      db.prepare('DELETE FROM model_cost_template_tiers WHERE template_id = ?').run(id);
    } else {
      if (!body?.expectNew) {
        throw new Error(`模板「${name}」不存在，可能已被删除，请刷新列表后再试`);
      }
      // 新建追加到列表末尾（spec: 模板条目列表排序）
      const r = db.prepare(
        `INSERT INTO model_cost_templates (name, unit, tiered, by_weekday, input_hit, input_miss, output, sort_order, group_name, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM model_cost_templates), ?, ?)`
      ).run(name, price.unit, price.tiered, price.byWeekday, price.inputHit, price.inputMiss, price.output, group ?? null, Date.now());
      id = Number(r.lastInsertRowid);
    }
    if (price.tiered) insertTiers(db, id, price.tiers);
    const finalGroup = group !== undefined
      ? group
      : (db.prepare('SELECT group_name FROM model_cost_templates WHERE id = ?').get(id)?.group_name ?? null);
    return { name, group: finalGroup, ...price };
  });
}

/** 按模板名删除模板（时段行经外键级联清理）；返回是否存在并删除 */
export function deleteModelTemplate(db, name) {
  const result = db.prepare('DELETE FROM model_cost_templates WHERE name = ?').run(String(name ?? '').trim());
  return Number(result.changes) > 0;
}

/**
 * 全量重排模板条目（spec: 模板条目列表排序）：orderedNames 必须与现存模板名集合完全一致
 * （缺、多、重名皆拒绝），事务内按位次密集重写 sort_order。纯配置展示层操作。
 * @param {string[]} orderedNames 重排后的完整模板名顺序
 * @returns {string[]} 重排后的名字顺序
 * @throws {Error} 名单与现存模板不一致
 */
export function reorderTemplates(db, orderedNames) {
  const names = (Array.isArray(orderedNames) ? orderedNames : []).map((n) => String(n ?? '').trim());
  return runInTransaction(db, () => {
    const existing = db.prepare('SELECT name FROM model_cost_templates').all().map((r) => r.name);
    const valid = names.length === existing.length &&
      new Set(names).size === names.length &&
      existing.every((n) => names.includes(n));
    if (!valid) throw new Error('排序名单与现存模板不一致，请刷新列表后重试');
    const upd = db.prepare('UPDATE model_cost_templates SET sort_order = ? WHERE name = ?');
    names.forEach((n, i) => upd.run(i + 1, n));
    return names;
  });
}

/**
 * 批量改组（spec: 模板分组——单条改组与多选批量改组共用）：仅更新 group_name，
 * 不触碰 sort_order（改组不改变排序位置）。空组名 = 默认组（NULL）。
 * @param {string[]} names 模板名列表（全部必须存在，否则整体拒绝）
 * @param {string} group 组名（可空 = 默认组）
 * @returns {string[]} 改组的模板名列表
 * @throws {Error} 名单为空 / 组名超长 / 含不存在的模板
 */
export function assignTemplatesGroup(db, names, group) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error('请先勾选要改组的模板');
  const g = normalizeGroupName(group);
  return runInTransaction(db, () => {
    const upd = db.prepare('UPDATE model_cost_templates SET group_name = ? WHERE name = ?');
    for (const n of list) {
      if (Number(upd.run(g, n).changes) === 0) throw new Error(`模板「${n}」不存在，可能已被删除，请刷新列表后再试`);
    }
    return list;
  });
}

/* ================= JSON 备份（变更 entry-sort-and-template-backup，能力 model-price-backup） =================
 * 按组导出 / 目录扫描导入，落盘目录 = <运行数据根目录>/model-price/（调用方传入）。
 * - 纯独立配置的延伸：导出纯读库写目录（不开写事务）；导入只写模板两张表；
 * - 校验复用 normalizeTemplatePrice（其内部走 plan.js 共享函数），不另立副本；
 * - 合并语义：并集 + 模板级新者胜（文件 exportedAtMs vs 库内 updated_at_ms，严格大于才覆盖）→ 幂等。
 */

const BACKUP_KIND = 'my-kimicode-statistic/model-price';
const BACKUP_VERSION = 1;
const BACKUP_FILE_RE = /^model-price-\d{8}-\d{6}-\d+\.json$/;
const BACKUP_KEEP_PER_GROUP = 3;

const pad2 = (n) => String(n).padStart(2, '0');

/** 当日分钟数 → HH:MM（tierToWire 序列化用，与 parseHHMM 互逆） */
function minToHHMM(min) {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** 星期位掩码 → [1..7] 数组（1=周一 … 7=周日；与 normalizeWeekdays 互逆） */
function maskToDays(mask) {
  const days = [];
  for (let d = 1; d <= 7; d += 1) {
    if (mask & (1 << (d - 1))) days.push(d);
  }
  return days;
}

/** 时段行 DB 形态 → 备份载荷形态（HH:MM + 星期数组；rest 行时间置空、weekdays NULL 省略），供 normalizeTier 回路校验 */
function tierToWire(t) {
  return {
    ...(t.isRest ? { rest: true } : { start: minToHHMM(t.startMin), end: minToHHMM(t.endMin) }),
    ...(t.weekdays != null ? { weekdays: maskToDays(t.weekdays) } : {}),
    inputHit: t.inputHit, inputMiss: t.inputMiss, output: t.output
  };
}

/** 备份文件名时间戳（YYYYMMDD-HHmmss，同秒按两位序号排先后，风格对齐 snapshotDb） */
function backupStamp(now) {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

/**
 * 按组导出全部模板（spec: 按组导出与滚动保留）：
 * - 同组模板写同一 JSON 文件、不同组分文件；无模板的组不产生文件；
 * - 文件含 kind / version / exportedAt / exportedAtMs / group / templates（文件名内嵌时间戳）；
 * - 写后每组滚动保留最近 BACKUP_KEEP_PER_GROUP 份（按文件名字典序），组归属不可解析的文件永不自动删除；
 * - 纯读库 + 写目录：不开写事务、不改模板任何列。
 * @param {DatabaseSync} db
 * @param {string} dir 备份目录（<数据根目录>/model-price，不存在则创建）
 * @returns {{files: string[], dir: string}} 本次写出的文件名列表与目录
 */
export function exportTemplatesToDir(db, dir) {
  const templates = loadModelTemplates(db).templates;
  const byGroup = new Map();
  for (const t of templates) {
    const g = t.group || '';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(t);
  }
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const exportedAtMs = now.getTime();
  const files = [];
  for (const [group, list] of byGroup) {
    const payload = {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      exportedAt: now.toISOString(),
      exportedAtMs,
      group,
      templates: list.map((t) => ({
        name: t.name,
        group,
        unit: t.unit, tiered: t.tiered, byWeekday: t.byWeekday,
        inputHit: t.inputHit, inputMiss: t.inputMiss, output: t.output,
        ...(t.tiered ? { tiers: (t.tiers || []).map(tierToWire) } : {})
      }))
    };
    let fileName;
    for (let seq = 0; ; seq += 1) {
      fileName = `model-price-${backupStamp(now)}-${pad2(seq)}.json`;
      if (!existsSync(join(dir, fileName))) break;
    }
    writeFileSync(join(dir, fileName), JSON.stringify(payload, null, 2), 'utf8');
    files.push(fileName);
  }
  pruneBackups(dir);
  return { files, dir };
}

/**
 * 每组滚动保留最近几份：按文件内 group 归组（JSON 解析失败或组字段非字符串的文件
 * 不归属任何组、永不自动删除），组内按文件名字典序（时间戳+序号）从最旧开始删。
 */
function pruneBackups(dir) {
  const byGroup = new Map();
  for (const f of readdirSync(dir)) {
    if (!BACKUP_FILE_RE.test(f)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (typeof parsed?.group !== 'string') continue;
      if (!byGroup.has(parsed.group)) byGroup.set(parsed.group, []);
      byGroup.get(parsed.group).push(f);
    } catch {
      // 坏文件：不参与自动删除
    }
  }
  for (const files of byGroup.values()) {
    const sorted = files.sort();
    while (sorted.length > BACKUP_KEEP_PER_GROUP) unlinkSync(join(dir, sorted.shift()));
  }
}

/**
 * 目录扫描导入（spec: 目录扫描导入与合并；手动导入与启动自动加载共用同一实现）：
 * - 文件级校验失败（JSON 解析 / kind 或 version 不符 / templates 非数组 / exportedAtMs 非正数）
 *   静默跳过整文件；模板级校验失败（名字空 / 组名超长 / 价格与分段规则）静默跳过该模板；
 * - 目录内同名模板按 exportedAtMs 取最新（全局按模板名去重，并集合并）；
 * - 与库内比较：仅当文件 exportedAtMs 严格大于库内 updated_at_ms 才 upsert（新者胜，
 *   保护导出之后的手工修改；相等不写 → 同批文件重复扫描零写入，幂等）；
 *   命中既有行保持 sort_order（位置不动）、组随胜者文件还原；新行追加列表末尾；
 * - 库内存在而目录中不含的模板一律不动（并集不删除）；落库段单事务。
 * @param {DatabaseSync} db
 * @param {string} dir 备份目录（不存在 / 不可读时静默返回零结果，不阻断调用方）
 * @returns {{filesRead: number, filesSkipped: number, templatesSeen: number,
 *            imported: number, templatesSkipped: number}} 导入结果摘要
 */
export function importTemplatesFromDir(db, dir) {
  const summary = { filesRead: 0, filesSkipped: 0, templatesSeen: 0, imported: 0, templatesSkipped: 0 };
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return summary;
  }
  const winners = new Map(); // name → { name, group, exportedAtMs, price }
  for (const f of files) {
    summary.filesRead += 1;
    let payload;
    try {
      payload = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      summary.filesSkipped += 1;
      continue;
    }
    const fileValid = payload && payload.kind === BACKUP_KIND && payload.version === BACKUP_VERSION &&
      Array.isArray(payload.templates) && Number.isFinite(payload.exportedAtMs) && payload.exportedAtMs > 0;
    if (!fileValid) {
      summary.filesSkipped += 1;
      continue;
    }
    const fileGroup = typeof payload.group === 'string' ? payload.group.trim() : '';
    for (const raw of payload.templates) {
      summary.templatesSeen += 1;
      const name = String(raw?.name ?? '').trim();
      try {
        if (!name) throw new Error('模板名为空');
        // 模板级 group 优先（校验一致性可放宽：以文件级为兜底），空组 = 默认组
        const group = normalizeGroupName(
          typeof raw?.group === 'string' && raw.group.trim() ? raw.group : fileGroup
        );
        const price = normalizeTemplatePrice(raw, name);
        const prev = winners.get(name);
        if (!prev || payload.exportedAtMs > prev.exportedAtMs) {
          winners.set(name, { name, group, exportedAtMs: payload.exportedAtMs, price });
        }
      } catch {
        summary.templatesSkipped += 1;
      }
    }
  }
  if (winners.size === 0) return summary;
  runInTransaction(db, () => {
    const existingStmt = db.prepare('SELECT id, updated_at_ms FROM model_cost_templates WHERE name = ?');
    for (const w of winners.values()) {
      const existing = existingStmt.get(w.name);
      if (existing) {
        if (!(w.exportedAtMs > (existing.updated_at_ms ?? 0))) continue; // 库内较新或同批已导入：幂等跳过
        db.prepare(
          'UPDATE model_cost_templates SET unit = ?, tiered = ?, by_weekday = ?, input_hit = ?, input_miss = ?, output = ?, group_name = ?, updated_at_ms = ? WHERE id = ?'
        ).run(w.price.unit, w.price.tiered, w.price.byWeekday, w.price.inputHit, w.price.inputMiss, w.price.output, w.group, w.exportedAtMs, existing.id);
        db.prepare('DELETE FROM model_cost_template_tiers WHERE template_id = ?').run(existing.id);
        if (w.price.tiered) insertTiers(db, existing.id, w.price.tiers);
      } else {
        const r = db.prepare(
          `INSERT INTO model_cost_templates (name, unit, tiered, by_weekday, input_hit, input_miss, output, sort_order, group_name, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM model_cost_templates), ?, ?)`
        ).run(w.name, w.price.unit, w.price.tiered, w.price.byWeekday, w.price.inputHit, w.price.inputMiss, w.price.output, w.group, w.exportedAtMs);
        if (w.price.tiered) insertTiers(db, Number(r.lastInsertRowid), w.price.tiers);
      }
      summary.imported += 1;
    }
  });
  return summary;
}
