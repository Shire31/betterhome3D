# 用脚手架创建场景

脚手架锁定 Three.js 0.185.1，Python 标准库本地服务 + 原生 ES modules，只依赖 `three`。批注由 `annotations.js` 和 `server.py` 负责；入口 `main.js` 负责 WebGPU/PBR、TSL GTAO/SSGI、四时段灯光、铺满窗口、按需绘制、交互画质、模型加载/释放、自动隐墙和 PNG；`furniture-editor.js` 负责家具点选与变换，`scene.js` 负责具体设计。`ui.css` 统一工具栏、家具编辑和评论浮层的黑白中性色样式，使用语义 CSS 变量，不为视觉风格引入 React/Tailwind。模型缩略图、多角度预览与最终出图统一使用此 Three.js/WebGPU 渲染器；资产转换工具不承担出图。

## 创建与启动

```sh
python3 ~/.codex/skills/threejs-rendering/scripts/create_scene.py /absolute/new-project \
  --model /absolute/existing-room.glb --name '新房间'
cd /absolute/new-project
npm ci
npm run check
npm start
```

打开 `http://127.0.0.1:8768/`。`--model` 可重复传入，生成多个方案按钮。输出目录必须不存在，不覆盖已有工作。创建脚本要求 GLB 自带纹理/缓冲，发现外部依赖会报错，避免只复制模型后丢失颜色；需要外部文件的 glTF 可在现有项目中手动保留完整文件结构。脚手架复制提供的模型并记录本地来源，不内置家具库。新项目仍需选择、核对资产许可和材质；优先使用现有资产或 `find-3d-models`。导出 GLB 时保留贴图和节点 extras。

如果传入的是单件家具，可加 `--editable`，整件模型即可点选移动和旋转。完整房间默认固定；需要逐件编辑时在 `scene.js` 的 `assets` 中指定各件家具。生成命令仍将重复的 `--model` 作为独立方案，不自动推断组合摆放。

已有项目通常只需要改它的 `scene.js`；不要再次初始化整个项目。固定原项目的服务目录，避免让相对路径失效。脚手架启动命令从项目根目录提供服务；自行更换端口时使用 `python3 server.py --port PORT --directory 服务根目录`。只使用普通静态服务器时，渲染仍可运行，但不能保存评论或接收在线更新。

## 场景配置

最小配置只需 `scenes: [{ id, label, url }]`，自动按包围盒设置相机和默认光照。坐标为米，Y 轴向上；Euler 旋转单位为弧度。一个完整房间是一个 GLB，多件现成家具用同一个 `assets` 列表组合：

```js
import * as THREE from 'three/webgpu';
export default {
  title: '窗边工作室',
  timeOfDay: 'evening', // morning | noon | evening | night; default noon
  sunRotation: 0, // Rotate the preset sun path around Y to match the window orientation.
  exposure: .95,
  environmentIntensity: .5,
  roomBounds: { min: [0, 0, -5], max: [3.6, 2.7, 0] },
  scenes: [{
    id: 'a', label: '窗边书桌',
    assets: [
      { url: './models/room.glb' },
      { url: './models/desk.glb', name: 'window-desk', editable: '书桌', position: [1, 0, -4], rotation: [0, Math.PI, 0], scale: 1 },
      { url: './models/chair.glb', name: 'desk-chair', editable: '书桌椅', position: [1, 0, -3] },
      { url: './models/cup.glb', name: 'desk-cup', attachTo: 'window-desk', position: [1.2, .75, -4] },
    ],
  }],
  views: {
    dollhouse: { label: '整体', position: [6, 5, 5], target: [1.8, 1, -2.5], fov: 44 },
    plan: { label: '平面', position: [1.8, 10, -2.499], target: [1.8, 0, -2.5], rotate: false },
  },
  setup(scene) {
    // Optional: replace default sun/sky/indoor lights with project lighting.
    const sun = new THREE.DirectionalLight('#fff1de', 3);
    sun.position.set(-3, 7, -5); sun.castShadow = true;
    const sky = new THREE.HemisphereLight('#eaf2ff', '#aaa393', .3);
    const lamp = new THREE.PointLight('#ffd39b', 2, 5);
    lamp.position.set(1.8, 2.3, -2.5);
    scene.add(sun, sun.target, sky, lamp);
  },
  prepare(model, definition) {
    // Optional: project-specific material adjustments after import.
    // Clone a shared material before changing only one furniture instance.
  },
};
```

每个方案也可单独给 `roomBounds` 和 `views`。预览始终铺满工具栏下方的窗口，相机比例跟随实际可用宽高；不再使用预设 `aspect` 限制画幅。没有 `views` 会自动取包围盒。没有 `setup` 时使用自动匹配模型尺度的默认灯光。`setup(root, {manager})` 和 `prepare(model, definition, {manager})` 在每次模型载入时调用，可返回 Promise。`root` 是场景拥有的 Group；只向它添加建筑和灯光，不操作全局 renderer、DOM 或当前 `studio.scene`，不注册长期监听器。贴图加载器传入该 `manager`，例如 `new THREE.TextureLoader(manager)`；异步工作须在回调返回前启动并等待完成。这样新场景可以独立准备、失败后整体释放。动态修改灯光、材质或对象后调用 `window.studio.invalidate()`；遮挡物或投影灯变化还要调用 `invalidateShadows()`。

同一方案的重复 URL 只解析一次，实例共享 geometry/material；重复实例使用不同 `name`。支持骨骼克隆，本版不自动播放 glTF 动画。切换方案按队列串行提交，较新选择最终生效；正在进行的下载结束后才处理下一选择，以限制同时驻留模型数量。

## 清晨、中午、傍晚、黑夜

工具栏内置四时段选择；通用 `lighting.js` 调整太阳方向/强度、天空光、窗光、室内灯、发光灯罩、背景和反射。`scene.js` 的 `timeOfDay` 设初始时段，`sunRotation` 以弧度绕 Y 轴旋转太阳路径来对齐实际窗户。这是设计预设，不是按经纬度和日期计算日照。

默认光照包含太阳、天空和室内点光，裸 GLB 也可切换。提供 `setup` 后由项目布置真实灯位；Directional/Hemisphere/RectArea/Point 或 Spot 默认分别按 sun/sky/window/lamp 处理。特殊用途灯用 `light.userData.lightingRole = 'fixed'` 保持原值，或显式指定对应角色。灯具父组标记 `userData.lightingRole = 'lamp'` 后，其材质原始 emissiveIntensity 也随时段变化；同一材质被非灯具共享时先克隆。发光材质本身不会照亮房间，应在灯具中放实际 Light。夜景增加室内灯强度，不增加灯或阴影数量。

需要金属反映室内结构时，在 `scene.js` 设置 `reflectionPosition: [x, y, z]`，位置应位于房间内部。入口用 128px PMREM 捕获静态建筑及灯光，排除家具，绑定到 metalness > .5 的材质。仅载入场景或切换时段时重算，移动家具不会启动额外六面渲染。同一场景持续复用原 PMREM renderTarget（原生 `fromScene` 的 `renderTarget` 参数），只更新纹理内容，场景释放时才销毁。r185 的材质节点可能仍缓存旧 envMap 绑定，换贴图后立即销毁旧纹理会导致 GPU 提交失败；仅设 `material.needsUpdate` 在此场景也不足以修复。切换失败重新捕获原时段。

自动隐墙且仍需遮光时，从 `./lighting.js` 导入 `addShadowShell`，仅对显式的静态建筑 Group 调用一次。它合并不透明投影几何到阴影专用 layer 1；主相机保留 layer 0。灯光的阴影相机自动包含 layer 1，因此视觉上隐藏墙面不会让阳光穿过实体墙。不要传入整间带家具的场景，否则移动家具后仍有原位阴影。合并壳不跟随建筑子节点编辑，建筑改变时重新构建。

```js
await studio.setTimeOfDay('night');
console.log(studio.timeOfDay, studioStats.timeOfDay); // id, label, switchMs
await (await import('./time-of-day-check.js')).checkTimeOfDay();
```

切换复用提交队列，在草稿、拖动和导出期间等待；完成后保留同一相机、模型和家具会话，失败恢复原时段。当前时段在同页方案切换/在线更新时延续，刷新后采用配置初始值。PNG 使用当前时段，记录在 `studioStats.lastExport.timeOfDay`。切换需要一次反射计算和绘制，可能短暂停顿；静止后不持续渲染。`npm run check` 包含无浏览器灯光/几何检查，浏览器检查还覆盖连续切换、GPU 校验错误、非黑色 PNG、失败回退和状态保留。

## 保持页面在线更新

服务保持运行。在 `scene.js`、相对导入模块和本地模型/贴图完成一组一致的修改后执行：

```sh
npm run check
npm run publish:scene
```

生成项目的发布命令等同于 `python3 server.py --publish scene.js`。入口在子目录时，例如服务根目录是项目而入口在 viewer：

```sh
python3 viewer/server.py --directory . --publish viewer/scene.js
```

页面每 1.5 秒检查已提交版本；顶部显示准备、等待、应用、已同步或失败，可点击重试。修改源文件但尚未提交时，正在打开的页面和方案切换继续使用旧版本。发布成功只证明文件版本完整，必须等 `studioStats.liveUpdate.phase === 'ready'` 且 `appliedRevision` 等于命令返回值，才证明当前客户端应用成功。

后台加载保留旧场景可用。评论草稿、表单输入、家具拖动、镜头拖动/按键、导出和隐藏页面会推迟应用。新场景准备好后替换场景内容，保留同一个页面、renderer、canvas、相机、当前方案和编辑开关。位置源值未变的家具保留用户调整；源文件明确改变原始位置/朝向/高度的家具采用新值。稳定对象 ID 让评论重新关联；删除或改变内容仍按批注规则提示，不猜替代目标。缺失资源、语法/准备/编译失败时保留旧画面，修正源文件重新提交；网络暂时失败可点重试。

`studio.checkSceneUpdate({retry:true})` 可立即检查。`studioStats.liveUpdate` 给出准备状态、请求版本、已应用版本和错误，`commitMs` 给出暂停提交的实测耗时。本版完整重建场景内容，后台准备时同时驻留新旧两份；编译和提交仍串行使用同一个 renderer，会保留最后画面并短暂停止 3D 交互。大型横厅实测提交约 2 秒，不能声称全程零卡顿。需进一步缩短时，再根据这个指标针对高成本对象做增量替换。

发布在 `.scene-updates/` 中保存不可变版本，相同字节按哈希共用存储，最后原子更新 `current.json`。它是可重建的发布缓存，设计来源仍是 `scene.js` 和模型文件。默认包含入口所在目录及服务根目录下 `models`、`textures`、`assets` 的运行时扩展文件，跳过 node_modules、renders、reference、批注截图、隐藏目录和符号链接。自定义资源目录用 `--resources models textures assets extra` 指定（替换默认列表）；实际用于渲染的参考图片应放入 textures。相对 JS imports 自动指向同一版本；本地资源通过 LoadingManager 改写版本 URL，blob/data 和外部 URL 原样保留。外部 URL 不冻结，离线/一致性要求高时先本地化资产。自定义 fetch 须 `await fetch(manager.resolveURL(url))`，不能让未受管理的下载在提交后才失败。

不要手改发布目录，也不要在仍有页面使用旧版本时清理它。没有自动历史回收：长期编辑产生大量版本时，关闭查看页、停服务后删除整个 `.scene-updates`，从源文件重新发布。通用 `main.js`、编辑器、HTML、依赖和服务代码升级仍需要一次页面加载/服务重启；此功能用于场景和资产更新，不是任意代码热替换。

发布/存储验证运行 `npm run check:server`。只有修改在线更新实现、需要运行完整回归时，才生成一次性项目（选小型边桌 GLB）；普通场景/评论修改复用正式页在线更新，不默认另开查看器。回归会创建和修改测试批注，不能在用户项目运行：

```sh
python3 ~/.codex/skills/threejs-rendering/scripts/create_live_check.py /absolute/new-test --model /absolute/table.glb
cd /absolute/new-test
npm ci
python3 server.py --port 8770
```

在该可见页面运行：

```js
await (await import('./live-update-check.js')).checkLiveUpdates(
  await (await fetch('./live-test-revisions.json')).json()
);
```

检查使用真实 WebGPU、版本模块、模型和评论存储，覆盖同页面替换、机位/家具状态、blob 贴图、相对依赖、评论/草稿/拖动保护、缺失资产/语法/贴图/编译失败、重试和 PNG。测试批注处理后关闭，原截图与历史保留；随即关闭临时测试标签页并停止该测试服务，保留正式页。

## 空间批注

双击可见表面在落点旁的输入条写评论，点击蓝色球体用同一输入条编辑已有正文，点发送确认；顶部「评论」才打开全局列表，关闭、重开、原始截图和历史操作保留在列表中。编辑保留原有空间锚点，取消不保存修改，失败保留输入供重试。评论和带落点的原始截图保存在项目文件中，刷新后保留。家具由 `name` 自动获得批注标识；自建墙面需要稳定的 `userData.annotation`。配置和助手读取/关闭方法见 [批注说明](annotations.md)。

## 家具编辑

`editable` 是显示名称，`name` 是方案内唯一且稳定的标识；墙、建筑和吊灯通常不标记。`attachTo` 指向同一方案中的可编辑根家具，摆件仍按场景坐标填写初始位置，装配时保持世界位置。父家具必须是独立的可编辑根，不支持嵌套编辑根或给同一摆件多个 owner；缺失父家具和重复名称会明确报错。

加载器把可编辑家具的缩放留在内部模型层，外层保持单位缩放，附着摆件随外层刚性运动。编辑根只允许水平朝向；模型坐标系校正或倾斜应放在内部模型中。项目 `prepare` 也可创建 `userData.editableLabel` 分组，但须是当前 `model` 的直接子项、有唯一名称、单位缩放。

点击家具后，同时显示 XZ 平移手柄和蓝色水平旋转环，无需切换模式。拖已选家具本体或箭头平移，拖圆环绕 Y 旋转；默认吸附 5cm / 5°，超过 5px 才开始改变家具，双击仍添加评论。空白处拖动镜头；拖动家具时锁定镜头并清除残留阻尼，Esc 撤销本次拖动，取消指针或失焦也回退本次操作。不显示家具操作面板、名称浮条或数值表单；点击空白或按 Esc 取消选择。脚本仍可通过 `editor.setPose()` 和 `editor.reset()` 精确修改或复位。桌面摆件整体跟随，建筑墙面遮挡点击。每个方案分别保留本次页面会话的修改，刷新恢复初始布置；没有文件持久化、自动碰撞或自动摆放。

**在线更新保留会话，不等于持久保存。** 评论已写入项目文件，家具拖动及镜头状态仍在页面内存中。优先保持页面在线；必须刷新/重开时，先把 `studio.editor.session`、当前方案、机位、target、FOV 和视角选择保存到页面外，再通过现有 `restoreSession()`、场景绑定和相机接口恢复并核对。仅存到页面变量不能跨刷新；原页面已丢失且没有快照时，明确无法完整恢复，不凭印象补成“已保留”。需要长期保存时再修改现有编辑器/项目存储并验证重开恢复；当前版本不能声称已经具备该能力。

两种原生 TransformControls 由已有编辑器统一分配指针，使用同一家具根；不各自绑定 DOM 抢占相机或批注操作。更新阴影与按需渲染；导出自动隐藏两种手柄和选框并在结束后恢复。旋转根使用 YXZ，回归检查经过 ±90° 与 ±180° 附近，防止 XYZ 分解与倾斜锁定把 165° 错折为 15°。新项目复用此实现，不另写旋转角计算。交互参考：[SketchUp 对象旋转手柄](https://help.sketchup.com/en/sketchup/basic-edits)、[Three.js TransformControls](https://threejs.org/docs/pages/TransformControls.html)。

## 家具候选

候选栏外层透明、无边框和阴影，每个选项独立使用浅色圆角底，家具缩略图保持正常不透明度。当前款以白底和小圆点标识，底部不重复显示名称，仅在加载或失败时显示状态。缩略图使用实际模型渲染的透明 PNG。点中提供了候选的家具，左侧出现竖排缩略图；点一张只替换该家具的视觉内容，稳定根节点、当前位置、朝向与镜头保持。当前款始终可切回。平移和旋转仍由已有编辑器负责；固定挂件也可只提供候选而不设置 `editable`。

在原资产上增加当前款的 `candidateLabel`、`thumbnail` 和替代款 `candidates`：

```js
{
  name: 'conversation-seat', editable: '会客区单椅',
  url: './models/red-chair.glb', position: [1, 0, 2],
  candidateLabel: '红色单椅', thumbnail: './models/red-chair.png',
  candidates: [
    { id: 'shell', label: '木框单椅', url: './models/shell.glb', thumbnail: './models/shell.png', scale: 1 },
    { id: 'blue', label: '浅蓝软椅', url: './models/blue.glb', thumbnail: './models/blue.png', scale: .85 },
  ],
}
```

`default` 保留给原资产，其他 ID 在同一家具内唯一。替代款的 `scale`、`rotation` 和 `offset` 作用于家具根节点内的模型，均为相对当前家具位置的修正；不继承原模型的缩放，也不自动猜朝向或拉伸尺寸。统一米制、Y 向上、正面和落地原点；吊灯/壁架要按挂点显式校正 offset。每个候选 GLB 是完整视觉单元，桌面组合应把配套摆件一起准备好；换桌子时不能默认让原桌面物件悬在空中。替代款使用文件内 PBR，不再次执行整场景 `prepare`，因此应预先导出正确材质。

初次设计或根据评论选型时，为有选择空间的重点家具准备 2–4 个经过筛选的现成款式，核对风格、尺寸、动线、材质和许可。缩略图要对应实际导出的模型。用户已否定的款式不充作新的推荐；质量不足时不为凑数量塞入无关资产。每个场景只配置已准备好的局部候选，不另造全局商城或资产搜索服务。

`furniture-candidates.js` 负责候选缓存和左侧 UI，复用现有 GLTF 加载器、提交队列、编辑器和批注模块。选中家具时按顺序预加载这一组，首次 shader 编译仍可能短暂等待；不要声称所有首次点击零延迟。失败保留当前款并可重试。切到其他家具时释放上一组未选中的替代款，保留原款和已选款；不创建额外 WebGPU canvas。

评论的稳定 ID 表示家具位，正文同时保存当时款式的 label、模型 source、几何/材质指纹与原截图。换款后旧评论显示内容已变化并隐藏原球，切回原款可重新关联，不能把旧坐标硬套到新几何。助手读评论时以其记录的具体模型和截图为准。

`studio.candidates.state` 可读取当前候选，`choose(id)` 可切换，`session` / `restoreSession()` 用于维护时备份选择。方案往返与在线更新保留仍存在的候选选择；这些选择与家具位置一样只在页面会话中，不是磁盘持久化。必须刷新时连同 `studio.editor.session` 一起备份到页面外。

最小测试用例位于 `candidate-check.js`：在一次性小场景配置可编辑 `seat`、`shell` 候选、缺失文件 `broken` 候选和 `other` 方案，然后运行 `checkCandidates()`。它会创建真实测试评论并在结束时关闭，不能在用户正式项目运行；覆盖原位替换、评论关联、丢失资源/编译失败回退、候选缓存、方案恢复、导出和过期切换。正式页仅做可恢复的 UI、模型与性能核对。

## 镜头键盘移动

W / ↑ 沿镜头朝向前进，S / ↓ 后退，A / ← 与 D / → 左右平移；镜头方向投影到水平地面，保持高度，位置与 OrbitControls target 同步移动。俯视也保留稳定朝向。按住连续移动，短按小步移动，松开停止；斜向与同义按键同时按下不会额外加速。默认速度 1.5 m/s，可用 `navigationSpeed` 调整。未实现碰撞检测。

输入框、下拉框、可编辑文字和 Ctrl / Cmd / Alt 快捷键不触发移动。失焦、页面隐藏、视角/方案切换、导出、家具拖动与 dispose 清除按键状态。键盘复用现有按需渲染和交互画质逻辑；不要再调用 `OrbitControls.listenToKeyEvents`，避免方向键被处理两次。

## 自动隐墙

建模/导出时为墙及依附的门框、挂画、窗帘设置 `userData.cutaway_wall` 为 `west/east/north/south`，天花板设 `userData.cutaway_ceiling = true`。原始门和吊灯必须确实存在于模型里；脚手架不会凭空补家具或推断门位置。

north 为 -Z、south 为 +Z，west 为 -X、east 为 +X。相机在房间外侧或上方时，按 `roomBounds` 判断遮挡侧；室内低视角保留外壳。非规则墙可标记 `cutaway_plane: {normal:[nx,nz], point:[x,z]}`，采用向外的单位法向与墙上一点；只有挡在相机与观察目标之间的外侧面会隐藏。相机高于上界时隐藏天花板和标记 `cutaway_partition` 的上部隔墙。门框、挂画等依附构件应跟随墙分组；不要为整个家具大组误打墙标签。未标记场景禁用隐墙按钮。

## 画质与验证

默认交互最长边 900px、静止最高 DPR 1.5、停止约 180ms 后恢复 GTAO；这些是可调起点。用 `quality: { interactionPixels, maxDpr, settleMs, aoRadius, aoStrength }` 修改。AO 为半分辨率 16 采样，场景 MRT 为 4x MSAA。间接光按钮启用静止时的 SSGI（2 slices × 6 steps + 空间降噪），移动时关闭；r185 的 SSGI 没有分辨率缩放接口，此处不做持续时域累积。关闭 AO 时移除 AO 节点执行，但场景仍写法线 MRT；测量证明确有成本时再拆两套 pass。默认 PNG 宽 1600，可配置 `exportWidth`。

真实 WebGPU 不可用时页面明确报错，不把 WebGL2 fallback 当成功。WebGL 的 EffectComposer/OutputPass 不进入该脚手架。`RenderPipeline` 做一次色调映射/输出转换；静态阴影缓存使用 `light.shadow.autoUpdate/needsUpdate`。

使用实际目标视口和可见页面。性能与静止短测复用现有页面，在用户未操作时保存并恢复状态；`checkViewer()` / `checkCameraKeys()` 会切换方案和操作控件，维护通用查看器时才在前述最小测试项目运行整组，不为每个检查另开标签页：

```js
studio.selfCheck(); // actual backend, model, output
await (await import('./viewer-check.js')).checkViewer(); // full viewport, editing, yaw boundaries, scene switches, exports
const checks = await import('./performance-check.js');
await checks.checkCameraKeys(); // direction, held/tapped keys, focus, export, scene changes
await checks.checkPerformance({ durationMs: 5000, minFps: 40 });
await checks.checkIdle();
const blob = await studio.exportPNG({ download: false });
const bitmap = await createImageBitmap(blob);
console.log(bitmap.width, bitmap.height, blob.size); bitmap.close();
```

`minFps` 是当前测试阈值，不是默认性能承诺。确认布局切换、低视角/各方向隐墙、导出图视觉、导出后继续旋转。`window.studioStats` 区分网络/解码、编译及首次提交时间；首次提交不代表 GPU 完成。查看帧时间 p95，不能只凭均值宣称不卡。关闭自己的临时测试页前可 `await studio.dispose()` 释放资源；不要对仍在使用的正式页执行该操作。

模板维护位置为本 skill 的 `assets/scaffold`，新项目是独立副本。更新通用入口后同步模板并验证一个实际生成项目；项目家具修正和坐标留在项目配置中，不能写进通用模板。
