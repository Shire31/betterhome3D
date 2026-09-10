# 检索现成 3D 模型

产物是看过预览、轮廓和尺寸适用、下载路线明确的少量模型及来源记录。复杂软包、布料、植物优先使用成熟资产；不要仅因为代码能拼出几何体就把它当作参考图的复现。

## 先选检索入口

- 先检查当前项目已有资产及其来源、预览和尺寸。适用的模型直接复用，不重新搜索。
- 家具、床品、灯具与摆件可从 [Blendkit](https://www.blendkit.com/) 开始。本仓库的 `scripts/blendkit.py` 提供搜索、缩略图和可下载免费模型的获取，不需要其他项目的下载器。
- 植物、自然物件、材质和 HDRI 可查 [Poly Haven](https://polyhaven.com/)。按具体资产页检查文件与许可。
- 已知品牌和型号时查品牌官网的 CAD/3D 下载；也可在 [3dsky](https://3dsky.org/) 补查家具。相似款不能标成原厂模型。先确认格式与贴图，只有 3ds Max 原生文件且没有可用转换路径的条目保持候选。

## 把参考图变成 query

先提取难改的特征：物件类型、轮廓、支撑结构、材质触感和占地。颜色易改，优先级低于轮廓；把“中古、温暖”转成 `teak`、`walnut`、`exposed wood frame`、`low back` 等可观察特征。

用一两个互补的英文短 query 开始，不把全部形容词塞进长句。Blendkit 示例：

```text
teak +category_subtree:sofa
wood +category_subtree:bed
metal +category_subtree:shelving
```

分类值应按库中实际分类核对，不把该过滤语法复制到其他搜索引擎。先看前几个结果判断词和分类是否起效，再决定下一步：

| 结果 | 下一步 |
| --- | --- |
| 多但跑题 | 换核心名词或收紧真实分类；不要继续堆风格词。 |
| 少或为零 | 放松颜色、木种或风格限制，再去掉分类补查。分类也可能标错。 |
| 类型接近、轮廓不对 | 交叉使用 sofa/couch/sectional、cabinet/sideboard/commode、bookcase/shelving 等同义词。 |
| 品牌词被当成普通名词 | 改成外形和用途；例如 `Flowerpot` 返回花盆时，按圆罩台灯的结构检索。 |
| 已有适用候选 | 停止继续翻页，进入下载与验证；不要为最少结果数反复优化 query。 |

已有案例中，`walnut bed` 返回跑题结果，放宽为 `wood` 并选 bed 分类后找到木床；`industrial bookcase` 轮廓不符，换成 metal 与 shelving 分类后找到窄型金属架。这些说明应按失败原因改词，不保证现在仍返回相同条目。网络错误必须单独报告，不能当成“没有模型”。

## 先看预览，再下载

按轮廓比例、表面细节、材质触感与可摆放性筛选，不能只匹配颜色。给需要比较的重点家具准备 2–4 个确实合适的候选；用户否定过的款式不充作新推荐。

元数据缺尺寸表示未知。作者的轴向可能不同，包围盒也可能包含拖线、垂落床品、第二件家具或辅助物。下载后检查主体和附件，不把整包尺寸当家具主体尺寸，不为塞进估算空间而大幅压扁或缩小模型。

保存稳定资产 ID、具体版本 ID、作者、许可、原始资产页、文件格式和选择理由。搜索排名和临时下载 URL 不能代替资产身份。缩略图用于初筛，实际模型仍需检查贴图、法线、单位与求值后的面数。

## 使用随仓库提供的脚本

以下命令在本仓库根目录运行；安装为 skill 时把脚本路径换成安装目录下的 `scripts/blendkit.py`。下载记录写入当前项目或临时工作目录，不提交到此公共仓库。

```sh
python3 scripts/blendkit.py search 'teak +category_subtree:sofa' 'walnut sofa' --out /absolute/project/search/sofas.json --limit 8
python3 scripts/blendkit.py thumbs --results /absolute/project/search/sofas.json --id ASSET_BASE_UUID
python3 scripts/blendkit.py fetch --results /absolute/project/search/sofas.json --id ASSET_BASE_UUID --out /absolute/project/downloads
```

从搜索结果取真实 `assetBaseId` 替换 `ASSET_BASE_UUID`，不是名称或结果序号。默认搜索免费条目；`--all-prices` 只扩展搜索，不购买。`fetch` 只获取服务标记为免费且允许下载的资产，优先 2K，`--resolution original` 获取原始包；网络请求有超时，失败会给出非零退出码并保留已完成的记录。权限或服务接口变化时，按错误检查官方资产页，不绕过访问限制。

脚本下载原生 `.blend`，同时保存来源 JSON 和文件校验值，不会自动转成 GLB。需要 Blender 时，只用它整理资产并导出米制、Y 向上的 GLB，保留材质贴图；仓库不包含通用原生资产转换器。发现缺贴图先核实材质是否实际使用，可补查原包；仍缺失就记录原因、选择备选，不伪造贴图或删除依赖检查来声称成功。

## 接入查看器

完成转换后按 [脚手架说明](scaffold.md) 导入 GLB。在 Three.js/WebGPU 中检查实际颜色、轮廓和占地，再制作真实模型缩略图、配置候选。原站预览正常不证明导出文件正常。复用同一个预览页和 renderer，顺序切换模型，不为每个角度开新页。

下载资产归当前项目所有；许可信息随资产保留，公开分享时按许可判断能否再分发。已有资产入库工具若共用一个文件目录或索引，按其实际写入规则操作，不并行覆盖记录。

脚本的离线检查：`python3 scripts/blendkit.py self-test`。真实搜索另用一条短 query 验证接口；搜索成功不等于下载成功，也不等于模型已可用于场景。
