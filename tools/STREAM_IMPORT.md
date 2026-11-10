# GDSII/OASIS 导入 VL3D

默认使用 `gdstk` 读取 GDSII/OASIS；`./bin/vl3d setup --native --install` 会把兼容版本安装到用户级隔离环境，不修改系统 Python。完整 KLayout 仍作为可选兼容后备，本项目不会安装、修复或修改系统 KLayout。

仅在显式使用 `--parser klayout`、传入 `--klayout`，或自动模式下 `gdstk` 不可用时需要 KLayout。KLayout 必须包含与主程序同版本的 database plugins；若插件缺失，应由系统维护者恢复完整安装，或通过 `KLAYOUT_BIN` / `--klayout /path/to/complete/klayout` 选择便携安装。

原生界面可直接点击 **Open file** 选择 `.json`、`.json.gz`、`.gds`、`.gdsii`、`.oas` 或 `.oasis`。多顶层 stream 会返回候选 cell，选定后继续导入；无需预先手工生成 JSON。

## 单文件导入

```bash
python3 tools/import_stream_layout.py chip.gds \
  --output build/chip.json \
  --library STREAM \
  --top TOP
```

输出为 compact schema v2 JSON，并同时生成 `chip.json.gz`。输入存在多个 top cell 时必须明确传 `--top`。默认 `--parser auto` 优先 `gdstk`；高级设置可固定为 `gdstk` 或 `klayout`。

## 合并到 viewer manifest

```bash
DATA_DIR="${VL3D_DATA_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/vl3d/data}"
mkdir -p "$DATA_DIR"
python3 tools/import_stream_layout.py chip.oas \
  --output "$DATA_DIR/STREAM@TOP@layout.json" \
  --library STREAM \
  --top TOP \
  --manifest "$DATA_DIR/manifest.json" \
  --manifest-mode merge \
  --manifest-prefix data
```

viewer 默认从 `$XDG_CACHE_HOME/vl3d/data`（未设置时为 `~/.cache/vl3d/data`）读取缓存；`VL3D_DATA_DIR` 可覆盖该位置。运行数据不应写入源码目录。

默认拒绝覆盖已有 layout JSON；使用 `--force` 后才替换，并在替换前生成 `.bak-YYYYMMDD-HHMMSS`。已有 manifest 在 merge/replace 前也会备份；可用 `--no-backup` 显式关闭。

推荐新文件使用 `library@cell@view.json`，避免 library/cell 名中的 `__` 造成身份碰撞。viewer 仍可读取已有 manifest 引用的旧 `library__cell__view.json` 缓存。

## PDK 自动识别与 Layer map

stream 文件只有 layer/datatype，不包含完整工艺语义。显式 profile 优先；其后检查Advanced 中的有界外部 profile 目录、最后使用 generic。数字层集合不能单独证明工艺：只有工艺名称证据和层集合一致、且候选唯一时才自动应用。自动命中会记录 `technology.profileMatch` 和 `VL3D-E5007` 提示。未知层保留原始数据，默认隐藏，不作为已确认的金属或 VIA。

若候选冲突或证据不足，在主 **Load / Load setup** 明确选择 PDK profile 或 layer map 后重新导入（独立脚本参数为 `--pdk-profile` / `--layer-map`）。外部目录可用重复的 `--pdk-profile-dir /absolute/real/path` 传入；目录数、文件数与总字节数有上限，并拒绝异常 profile。仓库不附带任何真实工艺的数字层映射，请自行提供。active、well、implant、marker 和 dummy/fill 用途不作为导体；poly/GT 和 contact/CT 保留。权威映射从完整层栈校准 Z；缺少校准时 Z 仅用于近似显示，不能用来推断 VIA 的电气端点。

也可用 JSON 手动映射到 viewer 层名和堆叠属性：

```json
{
  "201/0": {"name":"METAL1","kind":"metal","stackIndex":3,"thickness":0.2},
  "202/0": {"name":"VIA12","kind":"via","stackIndex":4,"thickness":0.1,"lowerLayer":"METAL1","upperLayer":"METAL2"},
  "203/0": {"name":"METAL2","kind":"metal","stackIndex":5,"thickness":0.2}
}
```

不提供或无法唯一识别映射时使用 `L<layer>_D<datatype>`，并在每个 shape/layer 对象中保留 `layerNumber`、`datatype`。映射项可设置 `purpose`；导入器仍会在 shape 上保留原始 datatype。对 VIA/CT 必须填写有依据的 `lowerLayer` / `upperLayer`（或 plural 端点）；显示位置和金属编号不能替代这些连接规则。

## 数据边界

- box、polygon、path 会按实例层次展开为 world 坐标；实例保留层级路径、master、bbox 和变换。
- polygon hole 会拆成无孔梯形，避免 3D 端错误填孔；因此输出 shape 数可能高于 stream 原始 shape 数。
- text/edge 等非 box/polygon/path 对象当前跳过，并计入 `exportStatus.unsupportedShapesSkipped`。
- GDSII/OASIS 不携带 OA 的完整 net/terminal/pin 连通语义，所以 `pins`、`connections` 和 shape `net` 明确为空。权威 layermap 可恢复独立 pin-purpose LPP 的显示用途，但不能凭几何可靠重建 terminal/net；需要 pin 追踪时，可使用 OA exporter，或按 [Pin 注解流程](../docs/PIN_ANNOTATION.md) 提供明确的层级、层名和 world 坐标。注解不猜 net、不修改原始 shape，也不补造器件规则。
- `--resource-mode low|balanced|large` 默认分别限制为 depth/shape `6/100000`、`8/200000`、`16/1000000`；`--max-depth`/`--max-shapes` 可显式收紧或覆盖，但 shape 上限不允许 unlimited/0。
- 触发 shape/depth 限制时会保留可用的部分结果，并在 `exportStatus.complete=false`、`truncationReasons` 和 `VL3D-E4004` warning 中明确报告，避免无界展开导致 OOM。

## 回归测试

```bash
python3 tools/test_stream_import.py
# 可选验证 KLayout 兼容后备：
KLAYOUT_BIN=/path/to/complete/klayout python3 tools/test_stream_import.py
```

测试会在临时目录生成一个含 box、polygon、path、数组实例和两级层次的 GDSII/OASIS，再验证 JSON/gzip、层号/datatype、层次路径、可选 layer map 及 manifest merge。
