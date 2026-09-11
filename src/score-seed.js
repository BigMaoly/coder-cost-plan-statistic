/*
 * score-seed.js —— 模型评分内置数据（纯数据模块；首次建库与「恢复内置数据」都写入这份）
 *
 * 本文件由 dev-file/scripts/build-score-seed.mjs 生成，不要手改；要改数据请改脚本里的来源表再重跑：
 *   node dev-file/scripts/build-score-seed.mjs      （在仓库根目录执行）
 *
 * 数据来源（只写来源里出现过的模型 / 标准 / 分数，没有任何编造数值）：
 *   w  = 官方网页表 https://github.com/MoonshotAI/Kimi-K3 「3. Evaluation Results」（2026-09-10 抓取）
 *   i1 = 图片①：19 benchmark × 7 模型 总表
 *   i2 = 图片②：GLM-5.3 / GLM-5.2 / Kimi K3 / Table 5 / GPT-5.6 Sol 的 6 张柱状图
 *   i3 = 图片③：GLM-5.3-Flash / GLM-5.2 / DeepSeek-V4-Vision-Exp / Claude Opus 4.8 / GPT-5.6 Terra / Gemini 3.7 Flash 的 6 张柱状图
 *   i4 = 图片④：MiniMax M3 的十张柱状图（本次只取 M3 列）
 *   i5 = 图片⑤：MiniMax M3 发布博客的 32 benchmark × 9 模型完整对比大表（2026-09-11 核对）
 * 每格多来源有值且不同时按 官方表 > 图片① > 图片② > 图片③ > 图片④ > 图片⑤ 取值；
 * 同名但量级明显不同的标准拆成「（官方表）/（对比图）」两条。
 * 逐格对照与冲突清单见 demos/260910-03-model-scorecard/数据来源核对.md。
 */

const criterionGroups = [
  { id: "g-reason", name: "推理与知识", order: 1 },
  { id: "g-code", name: "代码", order: 2 },
  { id: "g-agent", name: "智能体", order: 3 },
  { id: "g-vision", name: "视觉", order: 4 },
];

// 顺序 = 分组顺序 → 组内顺序；unit: pct（百分比）| num（数值）
const criteria = [
  // ── 推理与知识 ──
  { id: "c-gpqa", groupId: "g-reason", name: "GPQA Diamond", unit: "pct", order: 1, desc: "研究生水平科学问答（物理 / 化学 / 生物）。" }, // 来源：官方表 + 图片①
  { id: "c-critpt", groupId: "g-reason", name: "CritPt", unit: "pct", order: 2, desc: "物理推理题集；官方表标注取自 Artificial Analysis（2026-07-23）。" }, // 来源：官方表
  { id: "c-aalcr", groupId: "g-reason", name: "AA-LCR", unit: "pct", order: 3, desc: "长上下文推理；官方表标注取自 Artificial Analysis（2026-07-23）。" }, // 来源：官方表
  { id: "c-hlefull", groupId: "g-reason", name: "HLE-Full", unit: "pct", order: 4, desc: "Humanity's Last Exam 全量。官方表每格是「无工具 / 带工具」两个值，这里显示无工具值（带工具：Kimi K3 56.0、Claude Fable 5 63.0、GPT-5.6 Sol 58.0、Claude Opus 4.8 57.9、GPT-5.5 52.2）。" }, // 来源：官方表
  { id: "c-hle", groupId: "g-reason", name: "HLE", unit: "pct", order: 5, desc: "Humanity's Last Exam，对比图口径（原图 DeepSeek 侧带 * 的取带工具值）。" }, // 来源：图片①
  { id: "c-hle-tools", groupId: "g-reason", name: "HLE (w/tools)", unit: "pct", order: 6, desc: "HLE (w/tools)：允许调用工具后的得分（对比图口径）。名称保留限定词——去掉会与不带工具的 HLE 重名。" }, // 来源：图片① + 图片② + 图片③
  { id: "c-math-apex", groupId: "g-reason", name: "MathArena Apex", unit: "pct", order: 7, desc: "MathArena 的 Apex 难度档：竞赛级数学难题。" }, // 来源：图片①
  { id: "c-imo2025", groupId: "g-reason", name: "IMO 2025", unit: "pct", order: 8, desc: "IMO 2025：数学奥赛证明题（6 题满分 42，双评取低）；原图 M3 记 35/42，此处换算为百分制。目前仅 M3 有值；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-usamo2026", groupId: "g-reason", name: "USAMO 2026", unit: "pct", order: 9, desc: "USAMO 2026：数学奥赛证明题（6 题满分 42）；原图 M3 记 36/42 换算为百分制，其余模型原图即为百分比；来自对比图⑤。" }, // 来源：图片⑤
  // ── 代码 ──
  { id: "c-swebench-verified", groupId: "g-code", name: "SWE-Bench Verified", unit: "pct", order: 1, desc: "SWE-Bench Verified：真实 GitHub issue 修复率（Verified 集，Claude Code 脚手架跑 4 次取平均）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-swebench-pro", groupId: "g-code", name: "SWE-Bench Pro", unit: "pct", order: 2, desc: "SWE-Bench Pro：真实软件工程任务的修复率（Pro 难度档）；来自对比图④⑤。" }, // 来源：图片④ + 图片⑤
  { id: "c-sweatlas-qna", groupId: "g-code", name: "SWE Atlas-QnA", unit: "pct", order: 3, desc: "SWE Atlas-Codebase QnA：真实代码库问答任务（MiniMax 博客口径：4C8G 沙箱、3 小时超时）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-sweatlas-tw", groupId: "g-code", name: "SWE Atlas-Test Writing", unit: "pct", order: 4, desc: "SWE Atlas-Test Writing：代码库测试用例编写任务；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-swefficiency", groupId: "g-code", name: "SWE-fficiency", unit: "pct", order: 5, desc: "SWE-fficiency：在修复真实 issue 的同时衡量改动效率（开源数据集与流程）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-livesqlbench", groupId: "g-code", name: "LiveSQLBench", unit: "pct", order: 6, desc: "LiveSQLBench-Base-Full：真实 PostgreSQL 库上的 SQL 任务（600 题 / 22 库）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-clbench", groupId: "g-code", name: "CL-bench", unit: "pct", order: 7, desc: "CL-bench：代码任务评测（开源数据集 + 评分细则）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-kernelbench-hard", groupId: "g-code", name: "KernelBench Hard", unit: "pct", order: 8, desc: "KernelBench Hard：编写 / 优化 GPU kernel 的困难档；来自对比图④⑤。" }, // 来源：图片④ + 图片⑤
  { id: "c-paperbench", groupId: "g-code", name: "PaperBench", unit: "pct", order: 9, desc: "PaperBench：自主复现 AI 研究论文（19 篇可复现论文、官方人工评分细则）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-svgbench", groupId: "g-code", name: "SVG-Bench", unit: "pct", order: 10, desc: "SVG-Bench：按指令产出 SVG 图形的能力；来自对比图④⑤。" }, // 来源：图片④ + 图片⑤
  { id: "c-vibev2", groupId: "g-code", name: "VIBE V2", unit: "pct", order: 11, desc: "VIBE V2：纯前端与全栈 Web/Android/iOS 项目从零构建能力（来源大表归入 Coding 类，分组随之从视觉组挪到代码组）；来自对比图④⑤。" }, // 来源：图片④ + 图片⑤
  { id: "c-deepswe", groupId: "g-code", name: "DeepSWE v1.1", unit: "pct", order: 12, desc: "真实开源仓库上的软件工程任务修复率；官方表脚注说明报的正是 v1.1 任务。" }, // 来源：官方表 + 图片① + 图片② + 图片③
  { id: "c-progbench-w", groupId: "g-code", name: "ProgramBench（官方表）", unit: "pct", order: 13, desc: "ProgramBench（官方表）：从零写出可运行程序的能力（官方表口径）。名称保留来源标签——与对比图那条去掉标签会重名。" }, // 来源：官方表
  { id: "c-progbench-i", groupId: "g-code", name: "ProgramBench（对比图）", unit: "pct", order: 14, desc: "ProgramBench（对比图）：从零写出可运行程序的能力（对比图口径）。名称保留来源标签——与官方表那条去掉标签会重名。" }, // 来源：图片①
  { id: "c-tb21", groupId: "g-code", name: "Terminal-Bench 2.1", unit: "pct", order: 15, desc: "真实终端环境中的命令行任务完成率（2.1 版）。" }, // 来源：官方表 + 图片① + 图片③ + 图片④ + 图片⑤
  { id: "c-tb30", groupId: "g-code", name: "Terminal-Bench 3.0", unit: "pct", order: 16, desc: "终端任务 3.0 版，难度高于 2.1（两个对比图之间有几格数字不一致，取图片①的值）。" }, // 来源：图片① + 图片②
  { id: "c-tb40", groupId: "g-code", name: "Terminal-Bench 4.0", unit: "pct", order: 17, desc: "终端任务 4.0 版，目前最难的终端档位。" }, // 来源：图片①
  { id: "c-frontierswe", groupId: "g-code", name: "FrontierSWE", unit: "pct", order: 18, desc: "前沿难度软件工程任务；官方表报 dominance 分。" }, // 来源：官方表
  { id: "c-swe-marathon", groupId: "g-code", name: "SWE-Marathon", unit: "pct", order: 19, desc: "长程软件工程任务马拉松。" }, // 来源：官方表
  { id: "c-posttrainbench", groupId: "g-code", name: "PostTrainBench", unit: "pct", order: 20, desc: "后训练（模型微调）任务能力评测。" }, // 来源：官方表 + 图片⑤
  { id: "c-mlsbench", groupId: "g-code", name: "MLS-Bench-Lite", unit: "pct", order: 21, desc: "机器学习系统工程任务（轻量集）。" }, // 来源：官方表
  { id: "c-scicode", groupId: "g-code", name: "SciCode", unit: "pct", order: 22, desc: "科研级编程题；官方表标注取自 Artificial Analysis。" }, // 来源：官方表
  { id: "c-kimicodebench", groupId: "g-code", name: "Kimi Code Bench 2.0", unit: "pct", order: 23, desc: "Kimi 内部代码评测（2.0 版）。" }, // 来源：官方表
  { id: "c-nl2repo", groupId: "g-code", name: "NL2Repo-Bench", unit: "pct", order: 24, desc: "自然语言需求 → 完整代码仓库的端到端工程能力。图片① 与图片⑤（MiniMax 博客，含沙箱防作弊限制）口径不同，分值差异较大，按优先级取图片①。" }, // 来源：图片① + 图片⑤
  { id: "c-cybergym", groupId: "g-code", name: "CyberGym", unit: "pct", order: 25, desc: "网络安全攻防靶场综合表现。" }, // 来源：图片①
  { id: "c-secbench", groupId: "g-code", name: "SEC-Bench Pro", unit: "pct", order: 26, desc: "安全漏洞修复 / 利用能力，专业难度档。" }, // 来源：图片①
  { id: "c-exploitgym", groupId: "g-code", name: "ExploitGym", unit: "pct", order: 27, desc: "漏洞利用能力评测（Gym 环境）。" }, // 来源：图片①
  { id: "c-codeforces", groupId: "g-code", name: "Codeforces", unit: "num", order: 28, desc: "竞技编程 Elo 评分（数值型，不是百分比）。" }, // 来源：图片①
  // ── 智能体 ──
  { id: "c-browsecomp", groupId: "g-agent", name: "BrowseComp", unit: "pct", order: 1, desc: "网页浏览检索类智能体任务。" }, // 来源：官方表 + 图片④ + 图片⑤
  { id: "c-draco", groupId: "g-agent", name: "DRACO", unit: "pct", order: 2, desc: "DRACO：深度研究任务（官方评分细则逐题打分，评分模型 Claude Opus 4.6）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-deepsearchqa", groupId: "g-agent", name: "DeepSearchQA", unit: "pct", order: 3, desc: "DeepSearchQA（F1）：深度检索问答，指标为 F1。" }, // 来源：官方表
  { id: "c-researchrubrics", groupId: "g-agent", name: "ResearchRubrics", unit: "pct", order: 4, desc: "深度研究产出的评分细则达成率。" }, // 来源：官方表
  { id: "c-gdpval", groupId: "g-agent", name: "GDPval-AA v2", unit: "num", order: 5, desc: "GDPval-AA v2（Elo）：Artificial Analysis 的 GDPval v2，Elo 数值口径（单位已标为「数值」）。" }, // 来源：官方表 + 图片② + 图片③
  { id: "c-toolathlon", groupId: "g-agent", name: "Toolathlon-Verified", unit: "pct", order: 6, desc: "工具调用综合任务（复核版）。" }, // 来源：官方表
  { id: "c-mcpmark", groupId: "g-agent", name: "MCPMark-Verified", unit: "pct", order: 7, desc: "MCP 工具使用评测（复核版）。" }, // 来源：官方表
  { id: "c-mcpatlas", groupId: "g-agent", name: "MCP-Atlas", unit: "pct", order: 8, desc: "MCP 工具使用评测（Atlas 集，500 题公开子集）。" }, // 来源：官方表 + 图片④ + 图片⑤
  { id: "c-autobench-w", groupId: "g-agent", name: "AutomationBench（官方表）", unit: "pct", order: 9, desc: "AutomationBench（官方表）：端到端自动化办公任务（官方表口径，600 题公开子集）。名称保留来源标签——与对比图那条去掉标签会重名。" }, // 来源：官方表
  { id: "c-autobench-i", groupId: "g-agent", name: "AutomationBench（对比图）", unit: "pct", order: 10, desc: "AutomationBench（对比图）：端到端自动化任务（对比图口径；图片③ 标注为 AutomationBench v1.0.6）。名称保留来源标签——与官方表那条去掉标签会重名。" }, // 来源：图片① + 图片② + 图片③
  { id: "c-jobbench", groupId: "g-agent", name: "JobBench", unit: "pct", order: 11, desc: "职业场景任务评测。" }, // 来源：官方表
  { id: "c-aabriefcase", groupId: "g-agent", name: "AA-Briefcase", unit: "num", order: 12, desc: "AA-Briefcase（Elo）：Artificial Analysis 的办公交付物任务，Elo 数值口径（单位已标为「数值」）。" }, // 来源：官方表
  { id: "c-agents-last", groupId: "g-agent", name: "Agents' Last Exam", unit: "pct", order: 13, desc: "长程智能体任务综合考试（官方表为主，对比图补；两处数字不一致的按官方表取）。" }, // 来源：官方表 + 图片① + 图片② + 图片③
  { id: "c-gdpval-rubrics", groupId: "g-agent", name: "GDPval rubrics", unit: "pct", order: 14, desc: "GDPval rubrics：GDPval 的评分细则达成率口径（与官方表的 GDPval-AA v2 Elo 口径不同）；来自对比图④⑤。" }, // 来源：图片④ + 图片⑤
  { id: "c-bankertoolbench", groupId: "g-agent", name: "BankerToolBench", unit: "pct", order: 15, desc: "BankerToolBench：银行场景的工具调用任务；来自对比图④⑤。" }, // 来源：图片④ + 图片⑤
  { id: "c-apexagents", groupId: "g-agent", name: "APEX-Agents", unit: "pct", order: 16, desc: "APEX 智能体榜。" }, // 来源：官方表 + 图片⑤
  { id: "c-officeqa", groupId: "g-agent", name: "OfficeQA Pro", unit: "pct", order: 17, desc: "办公文档问答（PDF 全部以图片给出，无机器可读文本）。" }, // 来源：官方表 + 图片⑤
  { id: "c-spreadsheet-v1", groupId: "g-agent", name: "SpreadSheetBench-v1", unit: "pct", order: 18, desc: "SpreadSheetBench（v1）：电子表格任务 v1 口径（与官方表的 SpreadsheetBench 2 是不同版本）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-spreadsheet", groupId: "g-agent", name: "SpreadsheetBench 2", unit: "pct", order: 19, desc: "电子表格任务（第 2 版）。" }, // 来源：官方表
  { id: "c-osworld-v", groupId: "g-agent", name: "OSWorld-Verified", unit: "pct", order: 20, desc: "真实操作系统操作任务（复核版）。" }, // 来源：官方表 + 图片④ + 图片⑤
  { id: "c-osworld2", groupId: "g-agent", name: "OSWorld 2.0", unit: "pct", order: 21, desc: "操作系统操作任务（2.0 版）。" }, // 来源：官方表
  { id: "c-saasbench", groupId: "g-agent", name: "SaaS-Bench", unit: "pct", order: 22, desc: "SaaS 软件操作任务。" }, // 来源：官方表
  { id: "c-tau3banking", groupId: "g-agent", name: "τ³-Banking", unit: "pct", order: 23, desc: "银行场景工具调用任务（τ³）。" }, // 来源：官方表
  { id: "c-harvey", groupId: "g-agent", name: "Harvey Lab-AA", unit: "pct", order: 24, desc: "法律场景任务；报的是 criterion pass rate。" }, // 来源：官方表
  { id: "c-corpfin", groupId: "g-agent", name: "CorpFin v2", unit: "pct", order: 25, desc: "企业金融任务（第 2 版）。" }, // 来源：官方表
  { id: "c-financeagent", groupId: "g-agent", name: "Finance Agent v2", unit: "pct", order: 26, desc: "金融智能体任务（第 2 版）。" }, // 来源：官方表
  { id: "c-legalresearch", groupId: "g-agent", name: "Legal Research Bench", unit: "pct", order: 27, desc: "法律检索任务。" }, // 来源：官方表
  { id: "c-ycbench", groupId: "g-agent", name: "YC-Bench", unit: "num", order: 28, desc: "YC-Bench：创业孵化模拟智能体任务，指标为最终资产（原图记作 2.10M 等，此处按百万美元数值计）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-locabench", groupId: "g-agent", name: "LOCA-Bench", unit: "pct", order: 29, desc: "LOCA-Bench（256k）：长上下文智能体任务（官方 react 模式，环境描述长度 256k）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-claweval", groupId: "g-agent", name: "Claw-Eval", unit: "pct", order: 30, desc: "Claw-Eval：通用任务组（161 题）智能体评测，指标为 Pass³；来自对比图⑤。" }, // 来源：图片⑤
  // ── 视觉 ──
  { id: "c-worldvqa", groupId: "g-vision", name: "WorldVQA ForceAnswer", unit: "pct", order: 1, desc: "世界知识视觉问答。" }, // 来源：官方表
  { id: "c-omnidoc", groupId: "g-vision", name: "OmniDocBench", unit: "pct", order: 2, desc: "文档理解评测。" }, // 来源：官方表 + 图片⑤
  { id: "c-perception", groupId: "g-vision", name: "PerceptionBench", unit: "pct", order: 3, desc: "原子视觉感知能力（Kimi 内部评测）。" }, // 来源：官方表
  { id: "c-videomme", groupId: "g-vision", name: "Video-MME", unit: "pct", order: 4, desc: "Video-MME（w. sub）：视频理解，口径为带字幕。" }, // 来源：官方表 + 图片⑤
  { id: "c-videommmu", groupId: "g-vision", name: "Video-MMMU", unit: "pct", order: 5, desc: "Video-MMMU：视频多学科问答（1 FPS 抽帧、最多 512 帧，LLM-as-a-Judge 评分）；来自对比图⑤。" }, // 来源：图片⑤
  { id: "c-mmvu", groupId: "g-vision", name: "MMVU", unit: "pct", order: 6, desc: "多模态视频理解评测。" }, // 来源：官方表
  { id: "c-babyvision", groupId: "g-vision", name: "BabyVision", unit: "pct", order: 7, desc: "BabyVision（w/ python，对比图写作 (w/tools)）：基础视觉能力，允许调用 Python 工具。" }, // 来源：官方表 + 图片①
  { id: "c-mmmupro", groupId: "g-vision", name: "MMMU-Pro", unit: "pct", order: 8, desc: "多模态大学级题目（Pro 版）。官方表每格两个值（无工具 / 带工具），这里显示无工具值；图片⑤为单值口径。" }, // 来源：官方表 + 图片⑤
  { id: "c-charxiv", groupId: "g-vision", name: "CharXiv", unit: "pct", order: 9, desc: "CharXiv（RQ）：图表理解，RQ 子集。官方表每格两个值（无工具 / 带工具），这里显示无工具值。" }, // 来源：官方表
  { id: "c-mathvision", groupId: "g-vision", name: "MathVision", unit: "pct", order: 10, desc: "数学视觉题。官方表每格两个值（无工具 / 带工具），这里显示无工具值。" }, // 来源：官方表
  { id: "c-zerobench", groupId: "g-vision", name: "ZeroBench", unit: "pct", order: 11, desc: "ZeroBench（pass@5）：官方设置跑 5 次。官方表每格两个值（无工具 / 带工具），这里显示无工具值。" }, // 来源：官方表
  { id: "c-zerobench-main", groupId: "g-vision", name: "ZeroBench-main", unit: "pct", order: 12, desc: "ZeroBench-main（w/tools）：主榜口径，允许调用工具（对比图）。" }, // 来源：图片①
  { id: "c-chartography", groupId: "g-vision", name: "Chartography", unit: "pct", order: 13, desc: "Chartography（w/tools）：图表理解与生成类评测（对比图口径）。" }, // 来源：图片①
];

const modelGroups = [
  { id: "mg-kimi", name: "Kimi", order: 1 },
  { id: "mg-anthropic", name: "Anthropic", order: 2 },
  { id: "mg-openai", name: "OpenAI", order: 3 },
  { id: "mg-glm", name: "智谱 GLM", order: 4 },
  { id: "mg-deepseek", name: "DeepSeek", order: 5 },
  { id: "mg-google", name: "Google", order: 6 },
  { id: "mg-minimax", name: "MiniMax", order: 7 },
  { id: "mg-unknown", name: "未标注厂商", order: 8 },
];

const models = [
  // ── Kimi ──
  { id: "m-k3", groupId: "mg-kimi", name: "Kimi K3", order: 1 },
  { id: "m-k26", groupId: "mg-kimi", name: "Kimi K2.6 Thinking", order: 2 },
  // ── Anthropic ──
  { id: "m-fable5", groupId: "mg-anthropic", name: "Claude Fable 5", order: 1 },
  { id: "m-opus47", groupId: "mg-anthropic", name: "Claude Opus 4.7", order: 2 },
  { id: "m-opus48", groupId: "mg-anthropic", name: "Claude Opus 4.8", order: 3 },
  { id: "m-opus50", groupId: "mg-anthropic", name: "Opus 5.0", order: 4 },
  { id: "m-sonnet46", groupId: "mg-anthropic", name: "Claude Sonnet 4.6", order: 5 },
  // ── OpenAI ──
  { id: "m-gpt56sol", groupId: "mg-openai", name: "GPT-5.6 Sol", order: 1 },
  { id: "m-gpt55", groupId: "mg-openai", name: "GPT-5.5", order: 2 },
  { id: "m-gpt56terra", groupId: "mg-openai", name: "GPT-5.6 Terra", order: 3 },
  // ── 智谱 GLM ──
  { id: "m-glm51", groupId: "mg-glm", name: "GLM-5.1 Thinking", order: 1 },
  { id: "m-glm52", groupId: "mg-glm", name: "GLM-5.2", order: 2 },
  { id: "m-glm53", groupId: "mg-glm", name: "GLM-5.3", order: 3 },
  { id: "m-glm53f", groupId: "mg-glm", name: "GLM-5.3-Flash", order: 4 },
  // ── DeepSeek ──
  { id: "m-ds41f", groupId: "mg-deepseek", name: "DeepSeek V4.1-Flash", order: 1 },
  { id: "m-dspro", groupId: "mg-deepseek", name: "DeepSeek V4-Pro 0813", order: 2 },
  { id: "m-ds4f", groupId: "mg-deepseek", name: "DeepSeek V4-Flash 0731", order: 3 },
  { id: "m-dsvision", groupId: "mg-deepseek", name: "DeepSeek-V4-Vision-Exp", order: 4 },
  // ── Google ──
  { id: "m-gemini31", groupId: "mg-google", name: "Gemini 3.1 Pro", order: 1 },
  { id: "m-gemini37", groupId: "mg-google", name: "Gemini 3.7 Flash", order: 2 },
  // ── MiniMax ──
  { id: "m-minimax-m27", groupId: "mg-minimax", name: "MiniMax M2.7", order: 1 },
  { id: "m-minimax-m3", groupId: "mg-minimax", name: "MiniMax M3", order: 2 },
  // ── 未标注厂商 ──
  { id: "m-table5", groupId: "mg-unknown", name: "Table 5", order: 1 },
];

// scores[modelId][criterionId] = 分值；缺 = 该来源里没有这个分（未评分，不进图）
const scores = {
  "m-k3": {
    "c-gpqa": 93.5,
    "c-critpt": 23.4,
    "c-aalcr": 74.7,
    "c-hlefull": 43.5,
    "c-hle": 43.5,
    "c-hle-tools": 59.8,
    "c-math-apex": 65.6,
    "c-deepswe": 67.5,
    "c-progbench-w": 77.8,
    "c-progbench-i": 17.5,
    "c-tb21": 88.3,
    "c-tb30": 17.7,
    "c-tb40": 12.6,
    "c-frontierswe": 81.2,
    "c-swe-marathon": 42,
    "c-posttrainbench": 36.6,
    "c-mlsbench": 48.3,
    "c-scicode": 58.7,
    "c-kimicodebench": 72.9,
    "c-nl2repo": 58,
    "c-cybergym": 80,
    "c-browsecomp": 91.2,
    "c-deepsearchqa": 95,
    "c-researchrubrics": 76.2,
    "c-gdpval": 1686,
    "c-toolathlon": 76.5,
    "c-mcpmark": 94.5,
    "c-mcpatlas": 84.2,
    "c-autobench-w": 30.8,
    "c-autobench-i": 46.7,
    "c-jobbench": 54.3,
    "c-aabriefcase": 1548,
    "c-agents-last": 28.3,
    "c-apexagents": 41,
    "c-officeqa": 63.3,
    "c-spreadsheet": 34.8,
    "c-osworld-v": 84.8,
    "c-osworld2": 58.3,
    "c-saasbench": 60.1,
    "c-tau3banking": 33.4,
    "c-harvey": 94.6,
    "c-corpfin": 71.6,
    "c-financeagent": 54.4,
    "c-legalresearch": 44.2,
    "c-worldvqa": 51,
    "c-omnidoc": 91.1,
    "c-perception": 58.5,
    "c-videomme": 90,
    "c-mmvu": 82.1,
    "c-babyvision": 85.7,
    "c-mmmupro": 81.6,
    "c-charxiv": 84.8,
    "c-mathvision": 94.3,
    "c-zerobench": 23,
    "c-zerobench-main": 41,
    "c-chartography": 68.1,
  },
  "m-k26": {
    "c-swebench-verified": 80.2,
    "c-swebench-pro": 58.6,
    "c-nl2repo": 42.8,
    "c-browsecomp": 83.2,
    "c-mcpatlas": 66.6,
    "c-gdpval-rubrics": 65.12,
    "c-spreadsheet-v1": 84.5,
    "c-osworld-v": 73.1,
    "c-claweval": 61.5,
    "c-mmmupro": 79.4,
  },
  "m-fable5": {
    "c-gpqa": 92.6,
    "c-critpt": 28.6,
    "c-aalcr": 70,
    "c-hlefull": 53.3,
    "c-deepswe": 70,
    "c-progbench-w": 76.8,
    "c-tb21": 88,
    "c-frontierswe": 86.6,
    "c-swe-marathon": 35,
    "c-posttrainbench": 41.4,
    "c-mlsbench": 49.9,
    "c-scicode": 60.2,
    "c-kimicodebench": 76.9,
    "c-browsecomp": 88,
    "c-deepsearchqa": 94.2,
    "c-gdpval": 1747,
    "c-toolathlon": 77.9,
    "c-mcpmark": 87.4,
    "c-mcpatlas": 84.7,
    "c-autobench-w": 29.1,
    "c-jobbench": 57.4,
    "c-aabriefcase": 1583,
    "c-agents-last": 25.7,
    "c-apexagents": 43.3,
    "c-officeqa": 69.9,
    "c-spreadsheet": 34.7,
    "c-osworld-v": 85,
    "c-osworld2": 66.1,
    "c-tau3banking": 26.8,
    "c-harvey": 93.6,
    "c-corpfin": 71.8,
    "c-financeagent": 56.3,
    "c-legalresearch": 49.5,
    "c-worldvqa": 56.7,
    "c-omnidoc": 89.8,
    "c-perception": 57.2,
    "c-babyvision": 90.5,
    "c-mmmupro": 81.2,
    "c-charxiv": 88.9,
    "c-mathvision": 94.8,
    "c-zerobench": 23,
  },
  "m-opus47": {
    "c-usamo2026": 52.8,
    "c-swebench-verified": 87.6,
    "c-swebench-pro": 64.3,
    "c-sweatlas-qna": 45.16,
    "c-sweatlas-tw": 38.21,
    "c-swefficiency": 42.2,
    "c-livesqlbench": 41,
    "c-clbench": 22.92,
    "c-kernelbench-hard": 30.7,
    "c-paperbench": 58.5,
    "c-svgbench": 62.3,
    "c-vibev2": 55.87,
    "c-tb21": 66.1,
    "c-posttrainbench": 42.4,
    "c-nl2repo": 56.28,
    "c-browsecomp": 79.3,
    "c-draco": 77.7,
    "c-mcpatlas": 77,
    "c-gdpval-rubrics": 79.8,
    "c-bankertoolbench": 81.34,
    "c-apexagents": 37.2,
    "c-officeqa": 43.6,
    "c-spreadsheet-v1": 88.49,
    "c-osworld-v": 82.8,
    "c-ycbench": 2.19,
    "c-locabench": 57,
    "c-claweval": 71.6,
    "c-omnidoc": 89.3,
    "c-videommmu": 83,
    "c-mmmupro": 77,
  },
  "m-opus48": {
    "c-gpqa": 91,
    "c-critpt": 20.9,
    "c-aalcr": 67.7,
    "c-hlefull": 49.8,
    "c-hle-tools": 57.9,
    "c-deepswe": 59,
    "c-progbench-w": 71.9,
    "c-tb21": 84.6,
    "c-frontierswe": 66.7,
    "c-swe-marathon": 40,
    "c-posttrainbench": 34.1,
    "c-mlsbench": 42.8,
    "c-scicode": 53.5,
    "c-kimicodebench": 71.7,
    "c-browsecomp": 84.3,
    "c-deepsearchqa": 93.1,
    "c-researchrubrics": 73.5,
    "c-gdpval": 1593,
    "c-toolathlon": 76.2,
    "c-mcpmark": 76.4,
    "c-mcpatlas": 83.6,
    "c-autobench-w": 27.2,
    "c-autobench-i": 41,
    "c-jobbench": 48.4,
    "c-aabriefcase": 1354,
    "c-agents-last": 27,
    "c-apexagents": 39.4,
    "c-officeqa": 63.9,
    "c-spreadsheet": 31.6,
    "c-osworld-v": 83.4,
    "c-osworld2": 55.7,
    "c-saasbench": 56.1,
    "c-tau3banking": 27.6,
    "c-harvey": 91.1,
    "c-corpfin": 66.7,
    "c-financeagent": 53.9,
    "c-legalresearch": 43.8,
    "c-worldvqa": 39.1,
    "c-omnidoc": 87.9,
    "c-perception": 47.2,
    "c-videomme": 86,
    "c-mmvu": 79.2,
    "c-babyvision": 81.2,
    "c-mmmupro": 78.9,
    "c-charxiv": 80.5,
    "c-mathvision": 86.7,
    "c-zerobench": 17,
  },
  "m-opus50": {
    "c-gpqa": 93.4,
    "c-hle": 56.3,
    "c-hle-tools": 63.6,
    "c-deepswe": 74,
    "c-progbench-i": 37,
    "c-tb21": 89.1,
    "c-tb30": 43.3,
    "c-tb40": 51.8,
    "c-nl2repo": 75.3,
    "c-exploitgym": 22.1,
    "c-autobench-i": 50.3,
    "c-agents-last": 28.6,
    "c-babyvision": 94.1,
    "c-zerobench-main": 52,
    "c-chartography": 84,
  },
  "m-sonnet46": {
    "c-swebench-verified": 79.6,
    "c-sweatlas-qna": 31.2,
    "c-sweatlas-tw": 31.76,
    "c-browsecomp": 74.7,
    "c-draco": 75.8,
    "c-mcpatlas": 61.3,
    "c-gdpval-rubrics": 75.65,
    "c-apexagents": 26.2,
    "c-osworld-v": 72.5,
    "c-claweval": 68.3,
    "c-omnidoc": 86.9,
    "c-mmmupro": 74.5,
  },
  "m-gpt56sol": {
    "c-gpqa": 94.1,
    "c-critpt": 32.3,
    "c-aalcr": 73.7,
    "c-hlefull": 44.5,
    "c-hle": 44.5,
    "c-hle-tools": 64.5,
    "c-deepswe": 73,
    "c-progbench-w": 77.6,
    "c-progbench-i": 23,
    "c-tb21": 88.8,
    "c-tb30": 34.4,
    "c-tb40": 39.9,
    "c-frontierswe": 71.3,
    "c-swe-marathon": 39,
    "c-posttrainbench": 34.6,
    "c-mlsbench": 46.2,
    "c-scicode": 56.1,
    "c-kimicodebench": 64.8,
    "c-nl2repo": 56.8,
    "c-cybergym": 84.5,
    "c-secbench": 74.3,
    "c-exploitgym": 33.7,
    "c-browsecomp": 90.4,
    "c-researchrubrics": 73.8,
    "c-gdpval": 1736,
    "c-toolathlon": 74.9,
    "c-mcpmark": 92.9,
    "c-mcpatlas": 83.6,
    "c-autobench-w": 29.7,
    "c-autobench-i": 45.8,
    "c-jobbench": 45.4,
    "c-aabriefcase": 1495,
    "c-agents-last": 29.6,
    "c-apexagents": 39.9,
    "c-officeqa": 63.2,
    "c-spreadsheet": 32.4,
    "c-osworld-v": 83,
    "c-osworld2": 62.6,
    "c-saasbench": 61.4,
    "c-tau3banking": 33,
    "c-harvey": 87.2,
    "c-corpfin": 64.4,
    "c-financeagent": 53.8,
    "c-legalresearch": 48.1,
    "c-worldvqa": 41.8,
    "c-omnidoc": 85.8,
    "c-perception": 59.7,
    "c-videomme": 89.5,
    "c-mmvu": 81.2,
    "c-babyvision": 88.9,
    "c-mmmupro": 83,
    "c-charxiv": 84.6,
    "c-mathvision": 95.8,
    "c-zerobench": 17,
    "c-zerobench-main": 53,
    "c-chartography": 79.9,
  },
  "m-gpt55": {
    "c-gpqa": 93.5,
    "c-critpt": 27.1,
    "c-aalcr": 74.3,
    "c-hlefull": 41.4,
    "c-usamo2026": 98.21,
    "c-swebench-verified": 82.9,
    "c-swebench-pro": 58.6,
    "c-sweatlas-qna": 45.43,
    "c-sweatlas-tw": 42.59,
    "c-swefficiency": 46.6,
    "c-livesqlbench": 40.17,
    "c-clbench": 25.38,
    "c-kernelbench-hard": 20.9,
    "c-paperbench": 57.5,
    "c-svgbench": 58.2,
    "c-vibev2": 50.5,
    "c-deepswe": 67,
    "c-progbench-w": 70.8,
    "c-tb21": 83.4,
    "c-frontierswe": 64.9,
    "c-swe-marathon": 14,
    "c-posttrainbench": 28.4,
    "c-mlsbench": 35.5,
    "c-scicode": 56.1,
    "c-kimicodebench": 69,
    "c-nl2repo": 52.9,
    "c-browsecomp": 84.4,
    "c-researchrubrics": 64,
    "c-gdpval": 1491,
    "c-toolathlon": 73.5,
    "c-mcpmark": 92.9,
    "c-mcpatlas": 82.8,
    "c-autobench-w": 22.7,
    "c-jobbench": 38.3,
    "c-aabriefcase": 1158,
    "c-agents-last": 26.6,
    "c-gdpval-rubrics": 80.66,
    "c-bankertoolbench": 70.04,
    "c-apexagents": 38.5,
    "c-officeqa": 60.9,
    "c-spreadsheet-v1": 88.11,
    "c-spreadsheet": 29.1,
    "c-osworld-v": 79,
    "c-osworld2": 49.5,
    "c-saasbench": 43.8,
    "c-tau3banking": 31.3,
    "c-harvey": 86.3,
    "c-corpfin": 68.4,
    "c-financeagent": 51.8,
    "c-legalresearch": 40.4,
    "c-ycbench": 1.28,
    "c-worldvqa": 38.5,
    "c-omnidoc": 89.4,
    "c-perception": 55.8,
    "c-videomme": 89.3,
    "c-videommmu": 86.4,
    "c-mmvu": 81.7,
    "c-babyvision": 83.6,
    "c-mmmupro": 81.2,
    "c-charxiv": 84.1,
    "c-mathvision": 92.2,
    "c-zerobench": 22,
  },
  "m-gpt56terra": {
    "c-deepswe": 69.6,
    "c-tb21": 87.4,
    "c-gdpval": 1571,
    "c-autobench-i": 37.2,
    "c-agents-last": 28,
  },
  "m-glm51": {
    "c-swebench-pro": 58.4,
    "c-nl2repo": 41,
    "c-browsecomp": 79.3,
    "c-mcpatlas": 71.8,
    "c-gdpval-rubrics": 68.26,
    "c-spreadsheet-v1": 85.2,
    "c-claweval": 62.7,
  },
  "m-glm52": {
    "c-gpqa": 91.2,
    "c-critpt": 20.9,
    "c-aalcr": 71.3,
    "c-hle-tools": 54.7,
    "c-deepswe": 46.2,
    "c-progbench-w": 63.7,
    "c-tb21": 82.7,
    "c-tb30": 4.6,
    "c-frontierswe": 67.3,
    "c-swe-marathon": 13,
    "c-posttrainbench": 34.3,
    "c-mlsbench": 40.4,
    "c-scicode": 50.5,
    "c-kimicodebench": 64.2,
    "c-researchrubrics": 71.1,
    "c-gdpval": 1510,
    "c-toolathlon": 59.9,
    "c-mcpatlas": 82.6,
    "c-autobench-w": 12.9,
    "c-autobench-i": 26.2,
    "c-jobbench": 43.4,
    "c-aabriefcase": 1260,
    "c-agents-last": 20.4,
    "c-apexagents": 35.6,
    "c-officeqa": 41.4,
    "c-spreadsheet": 28.1,
    "c-tau3banking": 26.8,
    "c-harvey": 91,
    "c-corpfin": 66.1,
    "c-financeagent": 49.7,
    "c-legalresearch": 31.3,
  },
  "m-glm53": {
    "c-gpqa": 88.1,
    "c-hle": 42,
    "c-hle-tools": 62.5,
    "c-deepswe": 66.9,
    "c-progbench-i": 19,
    "c-tb21": 88.2,
    "c-tb30": 28.3,
    "c-tb40": 37.9,
    "c-nl2repo": 58,
    "c-cybergym": 84.5,
    "c-exploitgym": 15,
    "c-gdpval": 1769,
    "c-autobench-i": 48.8,
    "c-agents-last": 28.5,
  },
  "m-glm53f": {
    "c-hle-tools": 55.3,
    "c-deepswe": 63.4,
    "c-tb21": 84.3,
    "c-gdpval": 1773,
    "c-autobench-i": 48.8,
    "c-agents-last": 26.3,
  },
  "m-ds41f": {
    "c-gpqa": 90.9,
    "c-hle": 39.1,
    "c-hle-tools": 63.9,
    "c-math-apex": 65.6,
    "c-deepswe": 74.2,
    "c-progbench-i": 20.3,
    "c-tb21": 90.6,
    "c-tb30": 30,
    "c-tb40": 31.2,
    "c-nl2repo": 65.4,
    "c-cybergym": 88.1,
    "c-secbench": 62.8,
    "c-exploitgym": 15.3,
    "c-codeforces": 3471,
    "c-autobench-i": 54.8,
    "c-agents-last": 31.8,
    "c-babyvision": 89.6,
    "c-zerobench-main": 49,
    "c-chartography": 78.9,
  },
  "m-dspro": {
    "c-gpqa": 92.4,
    "c-hle": 42.7,
    "c-hle-tools": 60,
    "c-math-apex": 65.3,
    "c-swebench-verified": 80.6,
    "c-swebench-pro": 55.4,
    "c-deepswe": 62.7,
    "c-progbench-i": 15.5,
    "c-tb21": 87.9,
    "c-tb30": 11.8,
    "c-tb40": 12.4,
    "c-nl2repo": 61.5,
    "c-cybergym": 83.3,
    "c-codeforces": 3850,
    "c-browsecomp": 83.4,
    "c-mcpatlas": 73.6,
    "c-autobench-i": 43.2,
    "c-agents-last": 25.7,
    "c-gdpval-rubrics": 70.32,
    "c-spreadsheet-v1": 84.9,
    "c-osworld-v": 80.6,
    "c-claweval": 58.4,
  },
  "m-ds4f": {
    "c-gpqa": 89.9,
    "c-hle": 37.8,
    "c-hle-tools": 51.5,
    "c-math-apex": 58.6,
    "c-deepswe": 54.4,
    "c-tb21": 82.7,
    "c-tb30": 7.6,
    "c-tb40": 7,
    "c-nl2repo": 54.2,
    "c-cybergym": 76.7,
    "c-secbench": 39.8,
    "c-exploitgym": 2.65,
    "c-codeforces": 3840,
    "c-autobench-i": 37.7,
    "c-agents-last": 25.2,
  },
  "m-dsvision": {
    "c-hle-tools": 55.1,
    "c-deepswe": 59.3,
    "c-tb21": 83.9,
    "c-gdpval": 1675,
    "c-autobench-i": 38.8,
    "c-agents-last": 27.3,
  },
  "m-gemini31": {
    "c-usamo2026": 74.4,
    "c-swebench-verified": 80.6,
    "c-swebench-pro": 54.2,
    "c-sweatlas-qna": 13.5,
    "c-sweatlas-tw": 29.84,
    "c-swefficiency": 19.7,
    "c-livesqlbench": 39.83,
    "c-clbench": 21.06,
    "c-kernelbench-hard": 18.6,
    "c-paperbench": 46.7,
    "c-svgbench": 59.2,
    "c-vibev2": 28,
    "c-tb21": 70.3,
    "c-posttrainbench": 15.2,
    "c-nl2repo": 21.62,
    "c-browsecomp": 85.9,
    "c-mcpatlas": 69.2,
    "c-gdpval-rubrics": 57.82,
    "c-bankertoolbench": 67.03,
    "c-apexagents": 33.4,
    "c-officeqa": 18.1,
    "c-spreadsheet-v1": 56.06,
    "c-osworld-v": 76.2,
    "c-ycbench": 1.05,
    "c-claweval": 57.8,
    "c-omnidoc": 88.1,
    "c-videomme": 87.9,
    "c-videommmu": 87.9,
    "c-mmmupro": 80.5,
  },
  "m-gemini37": {
    "c-deepswe": 65.3,
    "c-tb21": 85.8,
    "c-gdpval": 1527,
    "c-autobench-i": 52.3,
  },
  "m-minimax-m27": {
    "c-swebench-verified": 79.9,
    "c-swebench-pro": 56.2,
    "c-sweatlas-qna": 11.29,
    "c-sweatlas-tw": 18.89,
    "c-swefficiency": 13.98,
    "c-livesqlbench": 33.17,
    "c-clbench": 15.38,
    "c-kernelbench-hard": 10.5,
    "c-paperbench": 30.6,
    "c-svgbench": 48,
    "c-vibev2": 37.89,
    "c-tb21": 51.1,
    "c-posttrainbench": 13.1,
    "c-nl2repo": 34.99,
    "c-browsecomp": 76.3,
    "c-draco": 66.77,
    "c-mcpatlas": 49.4,
    "c-gdpval-rubrics": 66.44,
    "c-bankertoolbench": 63.89,
    "c-apexagents": 5.6,
    "c-spreadsheet-v1": 84.92,
    "c-ycbench": 0,
    "c-locabench": 0,
    "c-claweval": 49.7,
  },
  "m-minimax-m3": {
    "c-imo2025": 83.3,
    "c-usamo2026": 85.7,
    "c-swebench-verified": 80.5,
    "c-swebench-pro": 59,
    "c-sweatlas-qna": 37.9,
    "c-sweatlas-tw": 30.83,
    "c-swefficiency": 34.8,
    "c-livesqlbench": 40.17,
    "c-clbench": 20.48,
    "c-kernelbench-hard": 28.8,
    "c-paperbench": 52.6,
    "c-svgbench": 63.7,
    "c-vibev2": 50.1,
    "c-tb21": 66,
    "c-posttrainbench": 37.1,
    "c-nl2repo": 42.13,
    "c-browsecomp": 83.5,
    "c-draco": 73.23,
    "c-mcpatlas": 74.2,
    "c-gdpval-rubrics": 74.7,
    "c-bankertoolbench": 76.1,
    "c-apexagents": 27.7,
    "c-officeqa": 45.1,
    "c-spreadsheet-v1": 89.35,
    "c-osworld-v": 75.2,
    "c-ycbench": 2.1,
    "c-locabench": 49.3,
    "c-claweval": 74.5,
    "c-omnidoc": 91.6,
    "c-videomme": 85.4,
    "c-videommmu": 84.6,
    "c-mmmupro": 78.1,
  },
  "m-table5": {
    "c-hle-tools": 63.9,
    "c-deepswe": 69.7,
    "c-tb30": 33.7,
    "c-gdpval": 1743,
    "c-autobench-i": 46.2,
    "c-agents-last": 23.8,
  },
};

export const SCORE_SEED = { criterionGroups, criteria, modelGroups, models, scores };
