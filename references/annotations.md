# 消费和维护空间批注

批注由脚手架的 `annotations.js` 和 `server.py` 提供。浏览器双击可见表面，使用落点旁的紧凑输入条写评论；蓝色球体与家具同帧渲染，使用 GPU 深度测试遮挡。点击球体复用同一个输入条并填入已有正文，可以直接编辑，点发送确认保存并收起。输入条只含文字、发送和取消，不显示关闭评论、原始视角或历史操作。顶部「评论」主动打开所有方案的列表，关闭、重开和原始视角/历史保留在列表中。正文作为纯文本处理。

只对当前打开的输入条按渲染帧投影，边缘自动避让，落点移出画面时隐藏；不加位置过渡动画、不另开定时器、不将全部球体改回 DOM。新建和编辑期间暂停相机/家具控制并延后场景提交，未保存内容必须发送或取消，Escape 等同取消。界面使用 `ui.css` 的黑白中性色，蓝色仅用于空间落点。

## 启动与文件

`npm start` 使用 Python 标准库服务，监听 127.0.0.1。它保留静态资源服务，并提供同源 JSON API。仅运行 `python -m http.server` 无法保存批注，页面会明确提示失败并保留草稿。

在服务的 `--directory` 下保存：

- `annotations.json`：首次保存后创建，包含 `schemaVersion: 1` 和 `comments`。它是唯一持久化事实源；不要另存一份待办清单。
- `annotation-snapshots/<id>.jpg`：创建时的原始视角，已画出蓝色命中点。评论关闭后仍保留。

提交由客户端生成 UUID，重试使用同一 UUID；响应丢失不会重复创建。服务串行提交并原子替换 JSON；保存失败不报告成功，损坏文件不会被空文件覆盖。当前仅支持一个本地服务进程写入，不支持多用户协同。

编辑更新同一记录的 `text` 和 `updatedAt`，不改变稳定 ID、空间锚点、原视角截图或关闭状态。`history` 中的 `action: "edit"` 记录修改前后的 `previousText/text`、操作来源和时间；消费时以当前正文为准，必要时核对修改记录。正文编辑也使用更新时间冲突检查，最近一次编辑的响应丢失可重试；后续已发生其他修改时返回 409，界面保留输入，不覆盖较新的评论。

## 消费者先读什么

1. 读取待处理评论的原文、方案名称、目标标签和稳定 ID。`target.id` 对应对象的 `userData.annotation.id`；模型资产默认是 `asset:<name>`。
2. 打开 `snapshot` 对应的本地图片。关注标记周围的家具和留白，区分点击位置与实际讨论范围；不要把点击椅腿理解为只改椅腿。
3. 根据 `target.sourceBase` 解析 `target.source`，并在 `target.sceneConfig` 中定位布局配置。`hitPath` 保留命中的原始节点路径，不凭 mesh 名称编造「靠背」等语义。
4. 在当前模型中确认对象及其关联状态。不能仅凭旧截图或原世界坐标修改现在的另一个对象。
5. 执行用户当前请求范围内的修改，运行 `npm run publish:scene` 提交版本，保持原页面/服务在线。确认 `studioStats.liveUpdate.appliedRevision` 等于发布返回的 revision 且 phase 为 ready，并在当前画面核对结果后关闭已完成的项。未完成、缺少关键决定的项保持打开。

每条记录还包含 `target.localPoint`、`localNormal`、创建时 `worldPoint/worldMatrix`，以及 `camera.position/target/fov/aspect/cutaway`。局部坐标随家具平移旋转；原世界坐标和矩阵保留当时的事实。在列表点击「查看」恢复原镜头方向，并按目标的当前位置平移机位，不重置用户其他家具调整。原截图用于核对原来的构图。

对象不存在时报告 `missing`，来源或内容指纹变化时报告 `changed` 并隐藏球体。不要自动寻找最近物体作为替代目标。指纹覆盖几何缓冲、局部结构、材质颜色/粗糙度和资产来源；纯外链贴图内容变化仍需通过截图核对。`other` 表示当前未加载该方案，不能误报为对象丢失。

## 浏览器内读取、关闭与重新打开

```js
await studio.annotations.reload();
studio.annotations.list();                  // open comments, enriched with currentTarget state
studio.annotations.list({ status: 'all' }); // includes immutable original context and status history
await studio.annotations.goTo(id);
await studio.annotations.close(id, '已更换单椅，并核对当前视角中的配色和通行空间');
await studio.annotations.reopen(id, '需要继续调整');
```

`close/reopen` 默认以 `assistant` 记入历史；界面按钮以 `user` 记入历史。这是操作来源记录，不是身份认证系统。关闭必须有具体处理说明；读过不等于处理完。用户授权助手关闭已完成评论后，不要逐条重复请求确认。关闭会收起标记和默认列表项，不会删除正文、空间信息、截图或历史。

不使用浏览器时，可直接读项目 JSON 和截图，通过同一个服务更新：

- `GET /api/annotations` → 完整文档。
- `PATCH /api/annotations/<id>`，Content-Type 为 `application/json`，body 为 `{status: "closed", actor: "assistant", note: "实际完成的修改及核对结果", expectedUpdatedAt: "刚读取的 updatedAt"}`。
- 重新打开使用 `status: "open"`。若得到 409，重新读取后判断，不能覆盖较新的状态。更新后调用页面的 `studio.annotations.reload()`，或重新打开批注面板查看结果。
- 编辑正文使用同一个 PATCH 路径，body 为 `{text: "修改后的正文", actor: "user", expectedUpdatedAt: "打开编辑时的 updatedAt"}`；这三个字段必须同时提供，不能混入 status 或空间信息。助手修改时 actor 使用 `assistant`。正文不能为空且最长 4000 字符。

不要直接编辑文件中的 status 绕过更新时间和处理历史。没有删除接口。

## 给场景对象加稳定身份

资产通过现有 `name` 自动标记；显示名优先取 `editable`。可用 `asset.annotation` 覆盖 id/label/source。固定墙面、地板和其他自建建筑分组直接设置：

```js
wall.userData.annotation = {
  id: 'wall:living-balcony',
  label: '客厅临阳台窗墙',
  source: './architecture.js',
};
```

ID 在方案内唯一，重新加载后保持一致，不能使用 Three.js 自动生成的 UUID。墙的内外侧由局部法向区分。同一个墙分组可以包含窗洞和多个实体段，具体落点和命中节点路径保留局部位置。身份不唯一的目标无法新建批注，不会随机绑定。

球体共享低面数几何与材质，不投影，普通 PNG 导出隐藏球体和编辑手柄。每个打开的球体增加两次简单绘制；大量评论时先实测再考虑实例化。不要重新加入约 10 FPS 的 DOM 定位或逐帧全场景遮挡射线。遮挡射线仅在点击球体时验证，避免隔墙点中球体。

## 验证

浮层/UI 改动可复用正式页，在当前方案至少有一条有效关联评论时运行：

```js
await (await import('./annotation-popover-check.js')).checkAnnotationPopover();
```

此检查临时把批注 API 限定为内存数据，覆盖球体点击进入编辑、输入条跟随与边缘避让、导出隐藏、新建/编辑发送、失败重试、冲突保护、取消与纯文本；不写入服务器，结束恢复镜头并重新读取真实评论。运行期间不要与用户同时操作评论。只验证交互，不替代下面的真实持久化检查。

运行 `npm run check:annotations` 检查真实 HTTP 存储的创建/正文编辑、幂等重试、空间信息保留、关闭重开、历史、冲突、非法输入和损坏文件保护。

在独立的可见测试项目中，先双击可编辑家具创建一条测试评论，再执行：

```js
await (await import('./annotation-check.js')).checkAnnotations();
```

此检查会操作并关闭测试评论，请勿在用户实际项目中运行。它覆盖原截图落点、移动旋转跟随、GPU 标记同步、对象变化、方案隔离、关闭重开和提交响应丢失后的重试。真实交互还应核对双击创建、点击球体、墙体遮挡以及移动时帧率；结束后保留用户自行写下的评论。
