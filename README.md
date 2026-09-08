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

![主面板首页](pic/260908-01-home.png)



