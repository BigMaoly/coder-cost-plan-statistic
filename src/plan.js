/**
 * 套餐配置（变更 add-plan-settings，设计 D1/D2/D3/D4）。
 * 按映射提供商维护套餐基础数据：条目（绑定一个映射，全局唯一互斥）、条目下的多个套餐
 * （名称 / 计费周期 / 单月费用 / 百分比或积分制配额）、当前使用套餐、模型直调费用，
 * 以及全局计费币种（CNY|USD，存 app_settings，缺省 CNY）。
 * - 纯配置数据：不读取、不写入任何 usage_* 统计表（铁律：防重复统计 / 增量统计零改动）。
 * - 模型直调费用支持分段计价（tiered + plan_model_price_tiers 时段行）：非分段条目
 *   tiered=0 且无 tiers 行，行为与分段功能引入前一致；分段条目主表行冗余第一行价格（兜底价）。
 * - 失效态（schema v7 起）：删除映射后条目保留（绑定悬空），界面警示并支持重绑到新的有效
 *   映射提供商；映射改名经 migratePlanOwnership 单事务迁移归属（子表 ON UPDATE CASCADE 跟走）。
 * - 保存为单事务整组替换（条目存在则先删后插，风格对齐 saveMapping）。
 * - 周限额估算区间为展示性推导，不落库：公式以 spec 为唯一事实源
 *   （tests/plan.test.js 用样例 31 天 / 100 分 → 400.00 ~ 500.00 锚定）。
 * - 套餐额度分段计价（schema v9 起，plan-quota-coef-tiering）：plan_quota_coefs /
 *   plan_quota_coef_tiers 两表，按「套餐 + 统一模型」存三组基础抵扣系数与可选时段倍率——
 *   **纯记录配置、无任何读取方**，不与 cost / quota / 统计链路联动（未来「额度统计」估值另行变更）；
 *   时段行校验经 normalizeTierCore 与价格 / 模板链共用同一份（铁律：不得复制副本）。
 */

import { runInTransaction } from './store.js';

/** 全局计费币种白名单（选项文字与展示图标，前端同构使用） */
export const CURRENCIES = [
  { code: 'CNY', label: '人民币', icon: '￥' },
  { code: 'USD', label: '美元', icon: '$' }
];

/* ================= 全局计费币种 ================= */

/** 缺省 CNY；存 app_settings.billing_currency，与 mapping_enabled 并列 */
export function getBillingCurrency(db) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'billing_currency'").get();
  return row?.value === 'USD' ? 'USD' : 'CNY';
}

export function setBillingCurrency(db, code) {
  if (code !== 'CNY' && code !== 'USD') {
    throw new Error('币种仅支持 CNY（人民币）或 USD（美元）');
  }
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('billing_currency', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(code);
  return code;
}

/* ================= 校验工具（message 为可直接展示的中文提示） ================= */

const planLabel = (name) => `套餐「${name || '（未命名）'}」`;

/** 非负数值（费用 / 价格）；非法返回 null。导出供费用模板模块共用（校验同构） */
export function toNonNegativeNumber(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 正整数（计费周期天数）；非法返回 null */
function toPositiveInt(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** 正数值（积分制总额度）；非法返回 null */
function toPositiveNumber(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 规范化 + 校验单个套餐；百分比套餐清空积分制字段，积分制套餐必填限额方式与总额度 */
function normalizePlan(raw, index) {
  const name = String(raw?.name ?? '').trim();
  const label = raw?.name ? planLabel(name) : `第 ${index + 1} 个套餐`;
  const cycleDays = raw?.cycleDays === '' || raw?.cycleDays == null ? 31 : toPositiveInt(raw.cycleDays);
  if (cycleDays === null) throw new Error(`${label}的计费周期须为正整数（天）`);
  const monthlyFee = toNonNegativeNumber(raw?.monthlyFee);
  if (monthlyFee === null) throw new Error(`${label}的单月费用须为非负数值`);
  const quotaMode = raw?.quotaMode;
  if (quotaMode !== 'percent' && quotaMode !== 'points') {
    throw new Error(`${label}的配额方式无效（应为百分比或积分制）`);
  }
  if (quotaMode === 'percent') {
    return { name, cycleDays, monthlyFee, quotaMode, limitPeriod: null, totalPoints: null };
  }
  const limitPeriod = raw?.limitPeriod;
  if (limitPeriod !== 'week' && limitPeriod !== 'month') {
    throw new Error(`${label}的积分制须选择限额方式（周 / 月）`);
  }
  const totalPoints = toPositiveNumber(raw?.totalPoints);
  if (totalPoints === null) throw new Error(`${label}的积分制须填写正数的总额度`);
  return { name, cycleDays, monthlyFee, quotaMode, limitPeriod, totalPoints };
}

/** HH:MM → 当日分钟数（0–1439）；时 0–23、分 0–59，非法返回 null。导出供费用模板模块共用 */
export function parseHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** 星期数数组（[1..7]，1=周一 … 7=周日）→ 位掩码（bit0=周一 … bit6=周日）；含非法值返回 null；空数组返回 0 */
export function normalizeWeekdays(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  for (const d of v) {
    const n = typeof d === 'number' ? d : Number(String(d ?? '').trim());
    if (!Number.isInteger(n) || n < 1 || n > 7) return null;
    seen.add(n);
  }
  let mask = 0;
  for (const d of seen) mask |= 1 << (d - 1);
  return mask;
}

/**
 * 时段行共享校验核心（plan-quota-coef-tiering 起，价格 / 模板 / 系数三条链共用同一份，铁律：不得复制副本）：
 * 校验时间段 HH:MM 与「剩余时段」位置（仅第二行起）、星期集合（区分星期开启时至少勾选一天）。
 * 返回 { sort, startMin, endMin, isRest, weekdays }；价格 / 倍率校验由各调用链自行补齐。
 */
export function normalizeTierCore(raw, index, entityLabel, { byWeekday = false } = {}) {
  const label = `${entityLabel}分段计价第 ${index + 1} 行`;
  const isRest = raw?.rest ? 1 : 0;
  let startMin = null;
  let endMin = null;
  if (isRest) {
    // 剩余时段仅允许从第二行起；时段字段置空（载荷中残留的时间值忽略）
    if (index === 0) throw new Error(`${label}不能设为剩余时段，第一行必须填写时间段`);
  } else {
    startMin = parseHHMM(raw?.start);
    endMin = parseHHMM(raw?.end);
    if (startMin === null || endMin === null) {
      throw new Error(`${label}的时间段无效（应为 HH:MM，时 0–23、分 0–59）`);
    }
  }
  let weekdays = null;
  if (raw?.weekdays == null) {
    if (byWeekday) throw new Error(`${label}未选择任何星期，请至少勾选一天（1=周一 … 7=周日）`);
  } else {
    weekdays = normalizeWeekdays(raw.weekdays);
    if (weekdays === null) throw new Error(`${label}的星期无效（应为 1–7 的数字数组，1=周一 … 7=周日）`);
    if (weekdays === 0) {
      if (byWeekday) throw new Error(`${label}未选择任何星期，请至少勾选一天（1=周一 … 7=周日）`);
      weekdays = null; // 空集合与不区分同义（仅区分星期关闭时可能出现）
    }
  }
  return { sort: index, startMin, endMin, isRest, weekdays };
}

/**
 * 规范化 + 校验一行分段计价时段行（价格链：共享核心 + 三组价校验）；勾选剩余时段（rest）后时段字段置空。
 * entityLabel 为可展示前缀（如「模型「x」」「模板「y」」），套餐与模板共用同一份校验（同构保证）。
 * weekdays 为星期集合（1–7 数组）落库为位掩码；byWeekday 开启时每行必须至少勾选一个星期。
 */
export function normalizeTier(raw, index, entityLabel, { byWeekday = false } = {}) {
  const core = normalizeTierCore(raw, index, entityLabel, { byWeekday });
  const label = `${entityLabel}分段计价第 ${index + 1} 行`;
  const inputHit = toNonNegativeNumber(raw?.inputHit);
  if (inputHit === null) throw new Error(`${label}的输入价格·缓存命中须为非负数值`);
  const inputMiss = toNonNegativeNumber(raw?.inputMiss);
  if (inputMiss === null) throw new Error(`${label}的输入价格·未命中须为非负数值`);
  const output = toNonNegativeNumber(raw?.output);
  if (output === null) throw new Error(`${label}的输出价格须为非负数值`);
  return { ...core, inputHit, inputMiss, output };
}

/** 规范化 + 校验一条模型直调费用；模型必须是绑定映射的统一模型名。分段条目主表行冗余第一行价格（兜底价）。
 *  区分星期（byWeekday）仅分段开启时有意义；剩余时段互斥：关闭区分星期时全部行中最多一行 rest，
 *  开启时允许多行 rest 但任意两行的星期集合不得完全相同。 */
function normalizePrice(raw, unifiedNames, mapName) {
  const model = String(raw?.model ?? '').trim();
  if (!model) return null; // 未选模型的空行保存时静默丢弃（对齐映射的不完整行处理）
  if (!unifiedNames.has(model)) {
    throw new Error(`模型「${model}」不是映射「${mapName}」的统一模型名，无法配置直调费用`);
  }
  const unit = raw?.unit;
  if (unit !== 'K' && unit !== 'M') throw new Error(`模型「${model}」的计价单位无效（应为 K 或 M）`);
  if (raw?.tiered) {
    const rawTiers = Array.isArray(raw?.tiers) ? raw.tiers : [];
    if (rawTiers.length === 0) {
      throw new Error(`模型「${model}」已开启分段计价，请至少保留一行时段价格`);
    }
    const byWeekday = raw?.byWeekday ? 1 : 0;
    const tiers = rawTiers.map((t, i) => normalizeTier(t, i, `模型「${model}」`, { byWeekday: byWeekday === 1 }));
    const rests = tiers.filter((t) => t.isRest);
    if (!byWeekday && rests.length > 1) {
      throw new Error(`模型「${model}」最多一行剩余时段，请把多余行改为填写具体时间段`);
    }
    if (byWeekday) {
      const seen = new Set();
      for (const t of rests) {
        if (seen.has(t.weekdays)) {
          throw new Error(`模型「${model}」相同星期配置下剩余时段行只能有一行，请合并或调整星期勾选`);
        }
        seen.add(t.weekdays);
      }
    }
    return {
      model, unit, tiered: 1, byWeekday,
      inputHit: tiers[0].inputHit, inputMiss: tiers[0].inputMiss, output: tiers[0].output,
      tiers
    };
  }
  const inputHit = toNonNegativeNumber(raw?.inputHit);
  if (inputHit === null) throw new Error(`模型「${model}」的输入价格·缓存命中须为非负数值`);
  const inputMiss = toNonNegativeNumber(raw?.inputMiss);
  if (inputMiss === null) throw new Error(`模型「${model}」的输入价格·未命中须为非负数值`);
  const output = toNonNegativeNumber(raw?.output);
  if (output === null) throw new Error(`模型「${model}」的输出价格须为非负数值`);
  return { model, unit, inputHit, inputMiss, output, tiered: 0, byWeekday: 0 };
}

/* ================= 加载与候选 ================= */

/**
 * 全部套餐配置条目（配置量极小，每次请求实时读，不落缓存）。
 * @returns {{currency: string, configs: Array<{mapName, stale, currentPlan, plans: Array, prices: Array}>}}
 *   stale = 绑定悬空（映射提供商已不存在，条目保留为失效态）；plans 按 sort 升序；prices 按配置先后（rowid）。
 */
export function loadPlanConfigs(db) {
  const currency = getBillingCurrency(db);
  const entries = db.prepare(
    `SELECT pc.map_name, pc.current_plan,
            NOT EXISTS (SELECT 1 FROM map_providers mp WHERE mp.name = pc.map_name) AS stale
     FROM plan_configs pc ORDER BY pc.sort_order, pc.rowid`
  ).all();
  const tierStmt = db.prepare(
    `SELECT sort, start_min AS startMin, end_min AS endMin, is_rest AS isRest, weekdays,
            input_hit AS inputHit, input_miss AS inputMiss, output
     FROM plan_model_price_tiers WHERE map_name = ? AND model = ? ORDER BY sort`
  );
  const configs = entries.map((e) => {
    // 分段条目回读时把 tiers 组装回价格条目；非分段条目 tiers 缺省（行为与引入前一致）
    const prices = db
      .prepare(
        `SELECT model, unit, tiered, by_weekday AS byWeekday,
                input_hit AS inputHit, input_miss AS inputMiss, output
         FROM plan_model_prices WHERE map_name = ? ORDER BY rowid`
      )
      .all(e.map_name);
    for (const p of prices) {
      if (p.tiered) p.tiers = tierStmt.all(e.map_name, p.model);
    }
    return {
      mapName: e.map_name,
      stale: Boolean(e.stale),
      currentPlan: e.current_plan ?? null,
      plans: db
        .prepare(
          `SELECT name, cycle_days AS cycleDays, monthly_fee AS monthlyFee, quota_mode AS quotaMode,
                  limit_period AS limitPeriod, total_points AS totalPoints
           FROM plan_settings WHERE map_name = ? ORDER BY sort, id`
        )
        .all(e.map_name),
      prices
    };
  });
  return { currency, configs };
}

/**
 * 绑定候选：映射配置中的全部统一提供商名，已被套餐条目绑定的带占用标记（所属条目映射名），
 * 供配置界面置灰不可选（spec: 候选携带占用状态）。
 */
export function listPlanCandidates(db) {
  const rows = db.prepare(
    `SELECT m.name AS name, p.map_name AS boundBy
     FROM map_providers m LEFT JOIN plan_configs p ON p.map_name = m.name
     ORDER BY m.rowid`
  ).all();
  return rows.map((r) => ({ name: r.name, boundBy: r.boundBy ?? null }));
}

/* ================= 保存与删除 ================= */

/**
 * 整条保存套餐配置条目（单事务：条目存在则套餐 / 费用整组 DELETE+INSERT 替换，不存在则新建）。
 * 失效条目重绑（schema v7 起）：body.rebindTo 指定新的有效映射提供商——以 URL 旧名定位条目，
 * 单事务内先迁移条目归属（子表经 ON UPDATE CASCADE 跟走），再按常规整组替换写入；
 * 目标仅可被本条目自身占用（同名失效条目接管场景：旧名映射被删除后又重建同名）。
 * 额度预设的归属迁移与 invalid 恢复由路由层在同一外层事务内完成（quota 表归 quota.js 独占）。
 * @param {object} body
 *   - mapName: 定位条目的映射提供商名（路由以 URL 名定位后传入；失效条目为悬空旧名）
 *   - rebindTo?: 重绑目标映射提供商名（仅失效条目重绑时携带）
 *   - expectNew: 新建草稿提交时为 true——同名条目已存在时拒绝（互斥冲突，已有配置不受影响）
 *   - plans: [{name, cycleDays, monthlyFee, quotaMode, limitPeriod, totalPoints}]（按界面顺序）
 *   - prices: [{model, unit, inputHit, inputMiss, output,
 *               tiered?, byWeekday?, tiers?: [{start, end, rest, weekdays?, inputHit, inputMiss, output}]}]
 *     （tiered 开启时 tiers 至少一行；start/end 为 HH:MM；rest 仅第二行起且时段置空；
 *       byWeekday 仅分段开启时有效——开启时每行 weekdays 须为 1–7 的非空数组，rest 行互斥见 normalizePrice）
 *   - currentPlan: 当前套餐名；不在本次套餐集合时自动回退集合首项，集合为空时置空
 * @returns {object} 保存后的条目（mapName 为保存 / 重绑后的归属名；与 loadPlanConfigs 条目结构同构）
 * @throws {Error} 校验失败（中文提示）
 */
export function savePlanConfig(db, body) {
  const mapName = String(body?.mapName ?? '').trim();
  if (!mapName) throw new Error('请先选择要绑定的映射提供商');
  const rebindTo = String(body?.rebindTo ?? '').trim();

  return runInTransaction(db, () => {
    const exists = Boolean(db.prepare('SELECT 1 FROM plan_configs WHERE map_name = ?').get(mapName));

    // 重绑：失效条目迁移归属到新的有效映射提供商（spec: 失效条目重绑成功 / 目标被占用拒绝）
    if (rebindTo) {
      if (!exists) throw new Error(`套餐配置条目「${mapName}」不存在，无法重绑`);
      if (!db.prepare('SELECT 1 FROM map_providers WHERE name = ?').get(rebindTo)) {
        throw new Error(`重绑目标映射提供商「${rebindTo}」在映射配置中不存在，请先在映射配置中创建`);
      }
      if (rebindTo !== mapName && db.prepare('SELECT 1 FROM plan_configs WHERE map_name = ?').get(rebindTo)) {
        throw new Error(`重绑目标「${rebindTo}」已被其它套餐配置条目绑定`);
      }
      if (rebindTo !== mapName) {
        db.prepare('UPDATE plan_configs SET map_name = ? WHERE map_name = ?').run(rebindTo, mapName);
      }
    }
    const targetName = rebindTo || mapName;
    if (!db.prepare('SELECT 1 FROM map_providers WHERE name = ?').get(targetName)) {
      throw new Error(`映射提供商「${targetName}」在映射配置中不存在，请先在映射配置中创建`);
    }
    const existsTarget = Boolean(db.prepare('SELECT 1 FROM plan_configs WHERE map_name = ?').get(targetName));
    if (body?.expectNew && existsTarget) {
      // 互斥冲突（如多端并发新建 / 同名失效条目占用）：拒绝保存，已有配置不受影响（事务回滚）
      throw new Error(`映射提供商「${targetName}」已被其它套餐配置条目绑定`);
    }

    const plans = (Array.isArray(body?.plans) ? body.plans : [])
      .map((p, i) => normalizePlan(p, i));
    const named = plans.filter((p) => p.name);
    if (named.length === 0) throw new Error('请至少添加一个套餐并填写套餐名称');

    const unifiedNames = new Set(
      db.prepare('SELECT DISTINCT unified_name FROM map_model_sources WHERE map_name = ?')
        .all(targetName).map((r) => r.unified_name)
    );
    const seenModels = new Set();
    const prices = [];
    for (const raw of Array.isArray(body?.prices) ? body.prices : []) {
      const price = normalizePrice(raw, unifiedNames, targetName);
      if (!price) continue;
      if (seenModels.has(price.model)) {
        throw new Error(`模型「${price.model}」重复配置费用，同一条目内一个模型只能有一条费用`);
      }
      seenModels.add(price.model);
      prices.push(price);
    }

    // 当前套餐：越界自动回退集合首项；集合为空置空（spec: 当前套餐自动回退）
    const currentPlan = named.some((p) => p.name === body?.currentPlan)
      ? body.currentPlan
      : named[0].name;

    if (!existsTarget) {
      // 新建条目追加到列表末尾（spec: 套餐条目列表排序——新建追加末尾，编辑 / 重绑路径不触碰 sort_order）
      db.prepare(
        'INSERT INTO plan_configs (map_name, sort_order) VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM plan_configs))'
      ).run(targetName);
    }
    db.prepare('DELETE FROM plan_settings WHERE map_name = ?').run(targetName);
    db.prepare('DELETE FROM plan_model_prices WHERE map_name = ?').run(targetName);
    db.prepare('DELETE FROM plan_model_price_tiers WHERE map_name = ?').run(targetName);
    db.prepare('UPDATE plan_configs SET current_plan = ? WHERE map_name = ?').run(currentPlan, targetName);
    const insPlan = db.prepare(
      `INSERT INTO plan_settings (map_name, name, cycle_days, monthly_fee, quota_mode, limit_period, total_points, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // 落库顺序保持界面顺序（无名套餐已在上方被过滤，不写入）
    let sort = 0;
    for (const p of named) {
      insPlan.run(targetName, p.name, p.cycleDays, p.monthlyFee, p.quotaMode, p.limitPeriod, p.totalPoints, sort);
      sort += 1;
    }
    const insPrice = db.prepare(
      `INSERT INTO plan_model_prices (map_name, model, unit, tiered, by_weekday, input_hit, input_miss, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insTier = db.prepare(
      `INSERT INTO plan_model_price_tiers (map_name, model, sort, start_min, end_min, is_rest, weekdays, input_hit, input_miss, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of prices) {
      insPrice.run(targetName, p.model, p.unit, p.tiered, p.byWeekday, p.inputHit, p.inputMiss, p.output);
      if (p.tiered) {
        for (const t of p.tiers) {
          insTier.run(targetName, p.model, t.sort, t.startMin, t.endMin, t.isRest, t.weekdays, t.inputHit, t.inputMiss, t.output);
        }
      }
    }

    return { mapName: targetName, currentPlan, plans: named, prices };
  });
}

/** 删除条目及其套餐 / 费用（子表经外键级联清理）；返回是否存在并删除 */
export function deletePlanConfig(db, mapName) {
  const result = db.prepare('DELETE FROM plan_configs WHERE map_name = ?').run(mapName);
  return Number(result.changes) > 0;
}

/**
 * 全量重排套餐条目（spec: 套餐条目列表排序）：orderedNames（映射提供商名，含失效条目）
 * 必须与现存条目集合完全一致（缺、多、重名皆拒绝），事务内按位次密集重写 sort_order。
 * 纯配置展示层操作，不触发统计 / 费用重算。
 * @param {string[]} orderedNames 重排后的完整提供商名顺序
 * @returns {string[]} 重排后的名字顺序
 * @throws {Error} 名单与现存条目不一致
 */
export function reorderPlanConfigs(db, orderedNames) {
  const names = (Array.isArray(orderedNames) ? orderedNames : []).map((n) => String(n ?? '').trim());
  return runInTransaction(db, () => {
    const existing = db.prepare('SELECT map_name FROM plan_configs').all().map((r) => r.map_name);
    const valid = names.length === existing.length &&
      new Set(names).size === names.length &&
      existing.every((n) => names.includes(n));
    if (!valid) throw new Error('排序名单与现存套餐条目不一致，请刷新列表后重试');
    const upd = db.prepare('UPDATE plan_configs SET sort_order = ? WHERE map_name = ?');
    names.forEach((n, i) => upd.run(i + 1, n));
    return names;
  });
}

/**
 * 套餐条目归属迁移（映射改名用，schema v7 起）：一句 UPDATE 迁移条目，
 * plan_settings / plan_model_prices / plan_model_price_tiers 经 ON UPDATE CASCADE 跟走。
 * 调用方保证：toName 在映射配置中存在且无同名套餐条目（含失效条目）。
 */
export function migratePlanOwnership(db, fromName, toName) {
  db.prepare('UPDATE plan_configs SET map_name = ? WHERE map_name = ?').run(toName, fromName);
}

/* ================= 展示性推导（唯一事实源 = spec，前端 web/app.js 同构实现） ================= */

/**
 * 周限额套餐按计费周期估算积分总额度区间：floor(周期÷7)×周额度 ~ ceil(周期÷7)×周额度。
 * 样例锚定：31 天 / 100 分 → 400.00 ~ 500.00。
 */
export function estimatePointsRange(cycleDays, weeklyPoints) {
  const days = Math.max(1, toPositiveInt(cycleDays) ?? 31);
  const per = toPositiveNumber(weeklyPoints) ?? 0;
  return { days, lo: Math.floor(days / 7) * per, hi: Math.ceil(days / 7) * per };
}

/* ================= 套餐额度分段计价（plan-quota-coef-tiering，schema v9） =================
 * 纯记录配置、无任何读取方：本区块只写 plan_quota_coefs / plan_quota_coef_tiers 两表，
 * SHALL NOT 读取或写入 usage_* / cost_* / quota_* 与统计链路（未来「额度统计」估值另行变更）。
 * 绑定粒度 = 套餐 + 统一模型（(map_name, plan_name, model) UNIQUE 互斥）；plan_name / model
 * 为软引用，悬空由读取侧标失效警示。实际抵扣系数 = 基础系数 × 时段倍率；未命中任何时段按
 * 基础系数 ×1 兜底（未来读取方口径，本次不实现）。时段行校验走 normalizeTierCore 共享核心。
 */

/** 系数 / 倍率必填校验：空值（null / undefined / 空白串）明确拒绝；
 *  非空走共享非负校验（toNonNegativeNumber 对空串折算 0 的宽松语义仅用于既有价格链，系数链不适用） */
function requiredNonNegative(v, entityLabel, fieldLabel) {
  if (v === null || v === undefined || String(v).trim() === '') {
    throw new Error(`${entityLabel}${fieldLabel}为必填项`);
  }
  const n = toNonNegativeNumber(v);
  if (n === null) throw new Error(`${entityLabel}${fieldLabel}须为非负数值`);
  return n;
}

/** 规范化 + 校验一行倍率时段行（系数链：共享核心 + 时段名称选填 + 倍率必填非负） */
function normalizeCoefTier(raw, index, entityLabel, { byWeekday = false } = {}) {
  const core = normalizeTierCore(raw, index, entityLabel, { byWeekday });
  const label = `${entityLabel}分段计价第 ${index + 1} 行`;
  const name = String(raw?.name ?? '').trim() || null; // 时段名称选填，仅供未来统计功能展示
  const multiplier = requiredNonNegative(raw?.multiplier, label, '的倍率');
  return { ...core, name, multiplier };
}

/**
 * 规范化 + 校验一条系数条目；模型必须是绑定映射的统一模型名、套餐必须属于本条目。
 * 分段规则与 normalizePrice 完全同构（至少一行 / 首行必填时段 / rest 互斥双规则）。
 * 套餐未选的空行保存时静默丢弃（对齐价格行的不完整行处理）；选了套餐未选模型则明确报错。
 */
function normalizeQuotaCoef(raw, planNames, unifiedNames, mapName) {
  const planName = String(raw?.planName ?? '').trim();
  if (!planName) return null;
  if (!planNames.has(planName)) {
    throw new Error(`套餐「${planName}」不是「${mapName}」条目内的套餐，无法绑定分段抵扣配置`);
  }
  const model = String(raw?.model ?? '').trim();
  if (!model) throw new Error(`套餐「${planName}」的分段抵扣条目未选择统一模型`);
  if (!unifiedNames.has(model)) {
    throw new Error(`模型「${model}」不是映射「${mapName}」的统一模型名，无法绑定分段抵扣配置`);
  }
  const entityLabel = `套餐「${planName}」模型「${model}」`;
  const inHit = requiredNonNegative(raw?.inHit, entityLabel, '的基础抵扣系数·输入缓存命中');
  const inMiss = requiredNonNegative(raw?.inMiss, entityLabel, '的基础抵扣系数·输入未命中');
  const out = requiredNonNegative(raw?.out, entityLabel, '的基础抵扣系数·输出');
  if (raw?.coefTiered) {
    const rawTiers = Array.isArray(raw?.tiers) ? raw.tiers : [];
    if (rawTiers.length === 0) {
      throw new Error(`${entityLabel}已开启分段倍率，请至少保留一行时段倍率`);
    }
    const byWeekday = raw?.byWeekday ? 1 : 0;
    const tiers = rawTiers.map((t, i) => normalizeCoefTier(t, i, entityLabel, { byWeekday: byWeekday === 1 }));
    const rests = tiers.filter((t) => t.isRest);
    if (!byWeekday && rests.length > 1) {
      throw new Error(`${entityLabel}最多一行剩余时段，请把多余行改为填写具体时间段`);
    }
    if (byWeekday) {
      const seenSets = new Set();
      for (const t of rests) {
        if (seenSets.has(t.weekdays)) {
          throw new Error(`${entityLabel}相同星期配置下剩余时段行只能有一行，请合并或调整星期勾选`);
        }
        seenSets.add(t.weekdays);
      }
    }
    return { planName, model, inHit, inMiss, out, coefTiered: 1, byWeekday, tiers };
  }
  return { planName, model, inHit, inMiss, out, coefTiered: 0, byWeekday: 0 };
}

/** 全部系数条目（配置量极小实时读，不落缓存）；分段条目回读时组装 tiers，非分段条目无 tiers */
export function loadPlanQuotaCoefs(db) {
  const rows = db.prepare(
    `SELECT id, map_name AS mapName, plan_name AS planName, model,
            in_hit_coef AS inHit, in_miss_coef AS inMiss, out_coef AS out,
            coef_tiered AS coefTiered, by_weekday AS byWeekday
     FROM plan_quota_coefs ORDER BY rowid`
  ).all();
  const tierStmt = db.prepare(
    `SELECT sort, name, start_min AS startMin, end_min AS endMin, is_rest AS isRest, weekdays, multiplier
     FROM plan_quota_coef_tiers WHERE coef_id = ? ORDER BY sort`
  );
  for (const r of rows) {
    r.coefTiered = Boolean(r.coefTiered);
    r.byWeekday = Boolean(r.byWeekday);
    if (r.coefTiered) r.tiers = tierStmt.all(r.id);
  }
  return rows;
}

/**
 * 整组替换某映射名下的系数条目（单事务；路由层在 PUT /api/plans 的外层事务内调用，
 * 与套餐本体同事务原子提交）。校验失败整体抛错回滚。
 * @param {Array} coefs [{planName, model, inHit, inMiss, out, coefTiered?, byWeekday?,
 *   tiers?: [{name?, start, end, rest, weekdays?, multiplier}]}]
 */
export function savePlanQuotaCoefs(db, mapName, coefs) {
  return runInTransaction(db, () => {
    const planNames = new Set(
      db.prepare('SELECT name FROM plan_settings WHERE map_name = ?').all(mapName).map((r) => r.name)
    );
    const unifiedNames = new Set(
      db.prepare('SELECT DISTINCT unified_name FROM map_model_sources WHERE map_name = ?')
        .all(mapName).map((r) => r.unified_name)
    );
    const normalized = [];
    const seen = new Set();
    for (const raw of Array.isArray(coefs) ? coefs : []) {
      const coef = normalizeQuotaCoef(raw, planNames, unifiedNames, mapName);
      if (!coef) continue;
      const key = coef.planName + '\u0000' + coef.model;
      if (seen.has(key)) {
        throw new Error(`套餐「${coef.planName}」的模型「${coef.model}」重复绑定分段抵扣条目`);
      }
      seen.add(key);
      normalized.push(coef);
    }
    // 整组替换：时段行经外键随条目级联清理
    db.prepare('DELETE FROM plan_quota_coefs WHERE map_name = ?').run(mapName);
    const insCoef = db.prepare(
      `INSERT INTO plan_quota_coefs (map_name, plan_name, model, in_hit_coef, in_miss_coef, out_coef, coef_tiered, by_weekday)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insTier = db.prepare(
      `INSERT INTO plan_quota_coef_tiers (coef_id, sort, name, start_min, end_min, is_rest, weekdays, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of normalized) {
      const info = insCoef.run(mapName, c.planName, c.model, c.inHit, c.inMiss, c.out, c.coefTiered, c.byWeekday);
      if (c.coefTiered) {
        for (const t of c.tiers) {
          insTier.run(Number(info.lastInsertRowid), t.sort, t.name, t.startMin, t.endMin, t.isRest, t.weekdays, t.multiplier);
        }
      }
    }
    return loadPlanQuotaCoefs(db);
  });
}
