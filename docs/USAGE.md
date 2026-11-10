# 使用 VL3D

## 第一次打开

安装依赖后运行 `./bin/vl3d gui --no-oa`，点击 **Load example**。它打开完全合成的
八边形电感 `examples/octagon-inductor.json`，无需 Cadence、PDK 或私有缓存。
选择 `UNDERPASS` 模块，在 pin 列表点击 **P2**。默认 **Physical geometry** 模式
会沿 M5 下穿线经 V5 过孔阵列追到 M6 螺旋，共 6 个图形。

浏览器界面的 **Example** 入口打开合成的物理追踪示例：选择 `TRACE/ROUTE`，点击
pin **IN**，应通过 M1/V1/M2/V2/M3 选中 8 个图形；没有 VIA 的交叉线、真实间隙和多边形孔洞
保持断开。也可以从文件入口打开 `examples/physical-trace-demo.json`。

## 加载自己的版图

原生界面的主要入口是 **Open file**、**OA library**、**Load example** 和
**Load setup**。Open file 选择 JSON/JSON.gz、GDS/GDSII 或 OAS/OASIS；OA library
选择库目录或包含 `cds.lib` / `lib.defs` 的工程。出现候选库或 top cell 时先选定
候选，再继续加载。Load setup 集中显示加载所需的输入及自动检测结果。

浏览器点击 **Load**，在同一个窗口选择三种来源：

| 来源 | 选择什么 | 所需环境 |
|---|---|---|
| Layout file · browser JSON | 浏览器文件选择器中的 JSON/JSON.gz | 无需 Cadence；可直接打开已包含 pins 的 annotated JSON。 |
| OA library | 服务器所在机器上的 OA 库/工程绝对路径 | 可用 Virtuoso、Cadence env、库映射及依赖技术库。 |
| Local file path · GDS/OAS/JSON | 服务器所在机器上的文件绝对路径 | GDS/OAS 需要现有 gdstk 或完整 KLayout；JSON 无需 Cadence。 |

OA 的 cell 候选直接显示在 Load 窗口，选择后继续打开。通过远程浏览器访问时，
OA 和 Local file path 中的路径仍属于**运行 VL3D 的机器**；只有 browser JSON
来源使用浏览器文件选择器，不能把浏览器电脑路径填成服务器路径。

`cds.lib`、Cadence env、PDK profile、layer map 和可选 pin annotations 都在
主加载设置中，按当前来源显示。先查看 Automatic / Selected / Needs input 状态：
自动找到时可继续；缺少条件时在对应字段补齐，候选不唯一时选择一项。配置 profile
只表明其来源，不能证明工艺规则完整。GDS/OAS 没有 pin 时仍可看模型；要按端口
追线，按 [Pin 注解流程](PIN_ANNOTATION.md) 准备明确的 sidecar。

**Advanced** 只保留库名、views、额外 profile 目录、资源模式和 strict 等选项。
历史保存的显式设置会继续生效，更换工程时应检查主加载窗口的当前值；临时选择
库候选不会重写站点配置。普通 OA 导出可以调用可用的 Virtuoso，无需另开其 GUI。
VL3D 自身采用 MIT 许可，没有激活码或账号；OA 导出使用用户已有的 Cadence 环境。

原生文件导入与模型编译期间可使用 **Cancel load**；取消不会替换当前模型。
OA prepare/export 当前是同步阶段，需要等待完成，不能把它当成可中断的导入任务。

JSON 必须已归一化为微米。遇到 nm/dbu 等单位提示时，按 [Layout JSON 单位合同](LAYOUT_JSON.md)
一致转换全部几何，不能只改 units 字段来绕过校验。

直接 JSON 使用文件内已确认的层规则，主加载不会把 profile/map 假装重新应用到 JSON。需要更改数字层含义时，应重新导入原 GDS/OAS 并选择映射，或取得正确的 OA 导出。取消或失败的新文件加载会保留旧版图及其 OA 会话。

## 层级和 pin

左侧层级树按实际实例路径区分模块，同一个 master 的不同实例可以分别选中。
模块选择包含其后代图形；pin 列表显示所选层级自己的端口。
同时选择多个模块时，列表保留完整实例路径以区分重名 pin。

选中模块后可查看其 pin 标记，并从列表选一项开始追踪。默认 Physical geometry
按真实几何连通；需要查看源数据的 net 注释时，明确切换为 **Named nets**。
Named nets 使用带实例作用域的 net 和父子端口映射，不会仅凭不同模块中的名字
相同就合并网络。

要练习 Named nets，可打开 `examples/hierarchy-demo.json`，切换模式后选择
`DEMO/U1` 的 A：它连到顶层 IN 和 `DEMO/U1/M0` 的 G，不混入 `DEMO/U2` 的 A。
选择子模块 `DEMO/U1/M0` 后，pin 列表改为该层级自己的 G。

### 物理连通追踪

pin 面板默认使用 **Physical geometry**；选中一个 pin 即开始追踪。此模式按
真实金属多边形接触和明确的 CT/VIA 上下层连接追踪，也能选中没有 net 名称的走线。
默认追到器件端口为止，不穿过 MOS、电阻、电容、电感内部把不同端口合并。
**Whole layout** 跨层级追踪；**Selected modules** 只在所选模块及后代内追踪，
线路延伸出范围时提示不完整。可以随时取消，切 pin 或版图也会取消旧任务。

同一个端口的多个 pin 图形都会作为种子；如果它们实际不连通，结果分别列出
连通分量并提示歧义。Trace details/diagnostics 显示规则、缺失信息和资源限制。
完整结果独立缓存，源文件或规则改变后自动失效。

可以打开 `examples/physical-trace-demo.json` 验证：`TRACE/ROUTE` 的 IN 跨三层
金属追出 8 个图形；无 VIA 的交叉线、真实间隙和多边形孔洞不会被误连。
示例完全合成，不需要 Cadence 或 PDK。

**数据边界**：旧 OA 导出应 Refresh，以修正旧 pathSeg 外框数据并补齐器件边界和真实 VIA 定义。缺少
这些证据时，几何结果会标记不完整，不能冒充验证过的电气网络。GDS/OAS 通常
缺少 pin 和器件语义，未标注端口的文件可按 [Pin 注解流程](PIN_ANNOTATION.md) 添加明确的端口图形，或使用 OA 导出。
浏览器直接提交的 JSON 超过 64 MiB 时使用桌面端 Open file。详细合同与验证
见[物理追踪说明](NET_TRACING_PLAN.md)。

## 层识别与三维显示

默认显示金属、VIA、poly/GT 和 contact/CT。active/DIFF/AA、well、implant、
marker、dummy 等用途不作为默认导体实体显示。层名和 purpose 一起决定分类。
“全部线路/图层”也仅启用导体层，不会重新打开 active 或 well。

OA 优先使用 technology library 和命名层信息。GDS/OAS 的 layer/datatype
数字没有跨 PDK 的统一含义；识别不明确时在主 **Load / Load setup** 选择正确的 PDK
profile 或 stream layer map。未知数字层保留数据并提示映射，默认不当成金属。
仓库只附带 generic 与虚构的 example-process profile，真实工艺请使用你自己的 profile。
自定义 profile 支持额外层名、VIA 端点和 stack 信息。

层厚和间距缺少可信技术数据时属于近似显示。Z 缩放只用于观察，不改变源坐标。
默认沿用原视效，但标明实际 Z 10×；原生界面的 **Z 1×** 按钮恢复等比例坐标。
这只消除视觉放大，不会把近似工艺层厚变成校准数据。
左键拖动旋转，Shift+左键、中键或右键拖动平移，滚轮缩放，**Fit** 适配窗口。
移动时使用 fast preview，停止后恢复细节。

## 看到“不完整”后如何处理

先展开追踪详情，按实际原因处理：

| 提示或缺少的信息 | 下一步 |
|---|---|
| 没有 pin | 用 [Pin 注解工具](PIN_ANNOTATION.md) 录入已知端口，或加载带端口的 OA 导出；不能从文字标签猜 pin。 |
| 未知数字层、VIA 端点缺失/未确认 | 选择正确的 profile 或 layer map，填写经确认的上下层关系后重新导入；单纯 Refresh 不会得到缺少的技术规则。 |
| 旧 `pathSeg`、旧器件元数据、导出截断 | 更新导出器后重新导出；截断时调整导出深度/数量或缩小输入，再检查详情中的新计数。 |
| `trace-stop-layer-semantics-unconfirmed` | 这是当前 PDK 派生停层语义尚未证明充分的合同限制。即使已经导出实际 VIA 和器件分类，也可能出现；反复 Refresh 无法解决。保留 limited 标记，按文档评估已确认的路由域。 |
| 路线超出所选模块 | 切换 **Whole layout** 再追踪。 |
| 内存、图形数或时间上限 | 先查看具体上限；缩小输入或使用更合适的资源设置。选择更小模块只限制遍历范围，并不缩小最初的整份输入索引。 |

PDK profile 的“已配置”只说明采用了哪个配置来源，不表示电气规则完整。
三维层栈近似、缺失连接规则和派生器件规则限制是不同问题；详情中的具体原因决定下一步。

## 开发与公开验证

启动 Web 服务后，运行 `node tools/verify_viewer.mjs --url http://127.0.0.1:5177/`。
默认只加载仓库的合成 hierarchy/physical 示例，验证层级、pin 和 8 图形物理连通结果；
不依赖私有缓存或 Cadence。需要现有 Node/Chromium 与 Python 运行环境。


`python3 tools/build_stress_layout.py --dry-run` 默认复制公开的 `hierarchy-demo.json`
为四实例合成压力版图，默认目标 `VL3D_STRESS/DEMO_x4/layout`。移除 `--dry-run`
才向用户缓存写入生成数据。额外总线和端口明确属于 synthetic 测试图形，不是电路提取结果。
可用 `--input /absolute/layout.json` 选择自己有权使用的数据；源码和 OA 原库不被修改。
