# my-kimicode-statistic

## 安装（本地编译安装）

需要 Node.js **≥ 22.13**（内置 `node:sqlite`，推荐 24+）。

```bash
# 方式一：克隆仓库后全局链接（推荐）
git clone https://github.com/BigMaoly/coder-cost-plan-statistic.git
cd coder-cost-plan-statistic
npm install          # 安装依赖
npm link             # 生成全局命令 my-kimicode-statistic

# 方式二：从本地目录直接全局安装
cd coder-cost-plan-statistic
npm install -g .

# 方式三：不安装，直接用 node 运行
cd coder-cost-plan-statistic
node bin/cli.mjs --help
```

安装后获得命令 `my-kimicode-statistic`；方式三可随时用 `node bin/cli.mjs …` 代替。

## 命令

实际上不需要cli来刷新，直接启动web就会完成一次刷新。
为了维持低性能开销，不会主动扫描，点击web右上角的刷新按钮即可刷新。

| 命令 | 说明 |
|---|---|
| `my-kimicode-statistic web` | 后台启动面板（0.0.0.0:18201 起，占用自动 +1），打印全部局域网地址后退出，不阻塞前台 |
| `my-kimicode-statistic web stop` | 停止后台服务 |
| `my-kimicode-statistic web status` | 查看运行状态与全部访问地址 |
| `my-kimicode-statistic data init` | 全量重建统计数据（首次安装时执行；清空后遍历全部可用平台全量扫描） |
| `my-kimicode-statistic data update` | 增量扫描 + 固化/归档维护（幂等，可随时执行） |
| `my-kimicode-statistic completions bash\|zsh` | 输出命令补全脚本，例如 `eval "$(my-kimicode-statistic completions bash)"` |

所有命令支持中文 `--help`。扫描摘要按工具分记；单个平台数据源缺失或失败只跳过并提示，不阻塞其余平台。

## 界面预览

启动：

```bash
my-kimicode-statistic web

# 输出下面的时你的局域网可以访问的ip地址和端口

统计面板已启动（后台运行，前台不阻塞）。可访问地址：
  http://127.0.0.1:18201
  http://192.168.1.1:18201   # 示例：局域网内其他设备可访问的本机地址
停止服务：my-kimicode-statistic web stop
```

---

![主面板首页](pic/260908-01-home.png)

每一个柱状体都可以点击查看详细使用情况。（注意：按 提供商 赛选状态时，无法点击柱状图查看详细）
柱状图下方两个统计区域，可以通过点击“详细”查看饼状图。

---

点击「⟳ 刷新」按钮即可完成一键数据扫描刷新（多平台增量扫描 + 当日固化），目前支持统计：**Kimi Code**、**ZCode**、**DeepSeek Harness (dsh)**、**Codex CLI**。

关于两个平台的说明：

- **Claude Code**：Claude 官方的多数统计数据的关键参数不存在，目前没有写适配器，只有通过 **CC Switch（ccswitch）** 路由方式连接使用的数据才会被统计；
- **Codex**：可以直接统计，但是你切换提供商时，记得通过你配置中的 `model_provider` 参数区分提供商。但如果 Codex 走 CC Switch 路由方式连接，可能无法识别出不同的提供商。

![刷新与筛选](pic/260908-02-refresh-filter.png)

## 设置说明

![设置](pic/260908-03-settings.png)

1. 第一个是用来添加“提供商”和“模型”的统一映射名称配置的。
  - 当你在不同工具中配置同一个提供商，或者配置了同一个提供商多种 url兼容接口时。
  - 当你的模型名字大小写不一，不同工具中显示方式不同时。
  - 当你向为提供商进行后续的套餐设置 和 token “等效价格” 估计。
  - 如果你希望把这些名字显示为统一的简短的提供商和模型名字。
  - 你就需要配置提供商。（例如：kimi、火山、阿里、GLM 等等)
2. 套餐，给已经配置好的提供商设置套餐和模型价格信息。
3. 模型价格模板，设置模型的价格模板，可以快速在套餐设置中使用这个价格模板。

### 提供商设置

你的同一个提供商接口，在不同工具中可能显示不同。
可以在这里把他们映射为同一个提供商，在统计时聚合显示。
同理，你的模型在不同模型中写法不同，但是也可以把他们的数据聚合显示。

![提供商与模型映射](pic/260908-04-provider-model-mapping.png)

你可以把你不需要显示的模型按照任意名字聚合显示。

![模型聚合](pic/260908-05-model-aggregate.png)

### 套餐设置

点击「添加」后，选择一个你配置好的提供商——一个提供商对应一个套餐。

![选择提供商](pic/260908-06-plan-provider.png)

绑定提供商之后，就可以点击「添加套餐」填写套餐信息：

![添加套餐](pic/260908-07-plan-add.png)

支持**百分比计费**和**积分制**。你甚至可以增加任意套餐——比如想要统计「100 元能用多久」，可以添加一个积分制的「100 元一个月、100 积分」的套餐。





