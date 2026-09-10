# BetterHome3D

一个可直接安装的 Agent skill，附带独立运行的 Three.js / WebGPU 场景脚手架。用于加载现成 GLB、搭建室内或产品场景，并在同一个页面中编辑家具、处理空间评论和更新设计。

通用交互已实现；具体资产、布局、机位与灯位由生成项目的 `scene.js` 配置。仓库不包含家具库或示例房间模型。

## 已有能力

- 真实 WebGPU、PBR、TSL GTAO / SSGI、按需绘制、交互期间降低渲染分辨率、PNG 导出。
- 铺满窗口的查看器、WASD / 方向键移动镜头、按标签自动隐墙。
- 点选家具后直接拖动本体或平移手柄，使用水平圆环旋转，无需操作面板或模式切换。
- 左侧竖排家具候选，局部换款并保留位置与朝向。
- 双击表面写评论，点击空间球体原位编辑；记录对象身份、局部落点、原始截图和处理历史，Agent 可读取并关闭已完成评论。
- 发布场景和模型更新后，在原页面应用，保留镜头及仍适用的家具调整，失败时保留旧场景。
- 清晨、中午、傍晚、黑夜灯光预设，以及渲染、交互和存储检查。

## 安装为 Codex skill

需要 Git；生成场景还需要 Python 3.10+、Node.js 20+ / npm，以及支持 WebGPU 的浏览器与 GPU。Three.js 锁定为 `0.185.1`，由 `npm ci` 安装。

```sh
git clone https://github.com/Shire31/betterhome3D.git \
  "${CODEX_HOME:-$HOME/.codex}/skills/threejs-rendering"
```

如果目标目录已经有同名 skill，先保留现有版本，不要覆盖未同步的改动。让 Codex 重新加载 skill 后可使用：

> 使用 $threejs-rendering，根据我的参考图创建新场景。复用现成模型和脚手架，配置家具候选、空间评论及在线更新。

其他 Agent 可以直接从 [SKILL.md](SKILL.md) 开始读取。必须保留整个仓库目录；仅复制 `SKILL.md` 无法运行生成器。文中提到的 `find-3d-models` 是可选的独立检索 skill，不是启动依赖。

## 不安装 skill，直接生成场景

```sh
git clone https://github.com/Shire31/betterhome3D.git
cd betterhome3D
python3 scripts/create_scene.py ../my-scene \
  --model /absolute/path/to/chair.glb --editable --name '我的场景'
cd ../my-scene
npm ci
npm run check
npm start
```

打开 <http://127.0.0.1:8768/>。输入模型须为包含贴图和缓冲的 GLB；完整房间模型省略 `--editable`。输出目录必须不存在，生成器不会覆盖已有项目。重复的 `--model` 创建独立方案，多件家具组合需编辑 `scene.js` 的 `assets`。

服务仅监听本机，不是面向公网的多人协作服务。已占用默认端口时，可在生成项目中运行 `python3 server.py --port 8770`。

## 配置与维护

| 入口 | 内容 |
| --- | --- |
| [SKILL.md](SKILL.md) | Agent 工作流程、资产和画质检查、性能诊断、浏览器负载控制 |
| [references/scaffold.md](references/scaffold.md) | 场景配置、家具候选、隐墙、灯光、在线更新与运行时检查 |
| [references/annotations.md](references/annotations.md) | 空间关联、评论读取、处理、关闭和冲突保护 |
| [scripts/create_scene.py](scripts/create_scene.py) | 从模板和用户提供的 GLB 创建独立项目 |
| [assets/scaffold/](assets/scaffold/) | 生成项目所使用的完整运行时代码及检查 |

修改生成项目中的场景和资产后运行：

```sh
npm run check
npm run publish:scene
```

在原页面确认新版本已应用；通用运行时代码或 HTML 升级仍需要重新加载页面。验证存储和发布服务可运行 `npm run check:server`；需要浏览器的验证及临时测试项目用法见脚手架说明。

## 当前边界

- 评论持久化到项目文件；家具移动、候选选择与镜头仅保留在页面会话，刷新前须按文档备份。
- 在线更新会准备新场景并提交，复杂场景可能短暂停顿，不是任意代码热替换。
- 家具比例、原点、朝向、候选缩略图、墙体标签及灯位需显式准备；没有自动布置或碰撞检测。
- WebGPU 不可用时明确报错，不静默退回 WebGL；性能须在目标设备、分辨率与资产规模下实测。

## 许可

仓库原创代码与文档采用 [MIT License](LICENSE)。Three.js 通过 npm 安装并遵循其自身许可；用户引入的模型、贴图和图片须遵守各自的许可，本仓库不包含这些第三方资产。
