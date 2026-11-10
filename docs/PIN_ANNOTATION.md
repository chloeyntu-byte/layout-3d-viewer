# 给 GDS/OAS 或 JSON 添加明确的 pin

GDS/OAS 通常没有 OA terminal/net 语义。VL3D 不会把文字标签、最近的走线或相同
名字猜成 pin。本流程把你明确给出的端口图形追加到**新 JSON**，保留原 shape、
原有 pin、层级、名称、尺寸和世界坐标。不需要 Cadence；注解工具仅使用 Python 3.6+
标准库。它不执行器件提取，也不会把未指定的 net 填成 terminal 名。

## 先跑公开示例

在工程根目录运行，输出文件必须尚不存在：

```bash
python3 tools/annotate_pins.py examples/pin-annotation-layout.json \
  --annotations examples/pin-annotations.json \
  --output /tmp/vl3d-annotated-example.json
```

用 VL3D 的 JSON 文件入口打开输出。在 `ANNOTATE/ROUTE` 下选 **A**，Physical
geometry 使用 M1/M3 上的两个端口图形作为同一 terminal 的种子，追出 8 个图形。
`ANNOTATE/CROSSING` 也叫 **A**，但属于另一实例，只连接自己的 M2 线。两个名称
不会因为相同而合并。示例完全合成，没有 PDK 或私有版图数据。

## 为自己的版图建立 sidecar

1. 先将 GDS/OAS 导入为 VL3D JSON，确认 top cell、层级路径与 layer map。
   可以使用界面的文件导入入口；独立脚本示例：

   ```bash
   python3 tools/import_stream_layout.py /absolute/chip.gds \
     --top TOP --library STREAM --layer-map /absolute/layers.json \
     --output /absolute/new-chip.json
   ```

   输出同时包含 JSON 和 gzip。GDS 读取需要现有 gdstk 或完整 KLayout；可以按
   [stream 导入说明](../tools/STREAM_IMPORT.md) 配置。注解工具本身不读取 GDS。

2. 对这份 JSON 生成身份和候选路径模板。选择一个新的 sidecar 文件名：

   ```bash
   python3 tools/annotate_pins.py /absolute/new-chip.json --inspect \
     > /absolute/chip-pins-template.json
   ```

   模板列出 `availableHierarchyPaths`、`availableLayers` 和当前 pin 图形数。
   保留它给出的 `source` 与 `units`，只按已知版图定义编辑 `pins`。
   `source.geometryDigest` 绑定物理几何、层级和源身份；不要自行编造它。

3. 每个 pin figure 写一条记录。以下是**格式示例**；路径、层名和坐标必须换成
   你自己的真实值，不能直接套用：

   ```json
   {
     "hierPath": "TOP/U1",
     "terminal": "A",
     "name": "A",
     "layer": "METAL1",
     "worldBBox": {"min": [10.25, 20.5], "max": [11.25, 21.0]}
   }
   ```

   坐标已经位于 top layout 的 world 坐标系，与 `units` 完全一致。源 JSON 必须符合
   [查看器的微米单位合同](LAYOUT_JSON.md)；不能只改单位文字来冒充转换。工具不会再次
   旋转、平移、缩放或转换单位。`worldBBox` 只用于你明确声明的矩形 pin，不是
   从走线外框猜端口。也可用 `points: [[x,y], ...]` 提供简单多边形；同时提供
   bbox 时，必须与这些点的精确边界相等。凹多边形可用，自交、零面积、非有限
   数值会拒绝；当前 sidecar 不接受带孔 pin 或中心线 path，应提供实际端口多边形。

   同一实例同一 terminal 的多 figure 可重复 `hierPath` + `terminal`，各条填写
   原始层和图形。不同实例中的同名 terminal 使用不同完整路径。`name` 可省略，
   默认沿用 terminal；提供的 Unicode、大小写和空格原样保留。`net` 可选，省略
   时为空，物理追踪不要求 net 名。已有 pin 不被覆盖；重复图形和冲突 id 会报错。

4. 输出到另一个尚不存在的 JSON，再打开它：

   ```bash
   python3 tools/annotate_pins.py /absolute/new-chip.json \
     --annotations /absolute/chip-pins-template.json \
     --output /absolute/new-chip-with-pins.json
   ```

   成功只增加 pin 记录、pinCount 和注解来源摘要。源文件与已有输出不可覆盖；
   失败不会发布半成品。重新生成时请选择新输出名。原 JSON 和 `.json.gz` 都可
   作为输入，独立工具的输出是 `.json`。

## 在主加载流程使用

主 **Load** 的本机 JSON/GDS/OAS 导入允许填写可选 pin annotations 文件，使用
服务器本机的**绝对 `.json` 路径**。对应接口是：

```json
POST /api/streams/import
{"path":"/absolute/chip.gds","top":"TOP","library":"STREAM","layerMapPath":"/absolute/layers.json","pinAnnotationsPath":"/absolute/chip-pins-template.json"}
```

先按相同 top/library/layer map 导入并检查 JSON，再生成 sidecar。直接重新导入原
GDS 时，必须保持这些选项与物理几何不变。服务器先转换，再校验注解，最后发布
新的缓存 JSON/gzip；校验失败显示 E6009，并保留原输入和先前有效缓存。注解内容
摘要和修改时间写入结果，注解改变后不会复用旧物理追踪结果。已有完整 pins 的
annotated JSON 可以直接打开，不要再次重复应用同一 sidecar。

## 报错与边界

| 报错/现象 | 处理 |
|---|---|
| Source identity / geometryDigest 不匹配 | 对当前转换后的 JSON 重新 `--inspect`；核对 top、library、层名与几何是否已变，复核原注解后再迁移。 |
| units 不一致 | 按源 JSON 单位提供真实坐标；工具不隐式换算。 |
| hierarchy / layer 不存在 | 从模板候选项复制准确路径/层名；先修 layer map 再建立新模板。 |
| invalid polygon / bbox | 使用真实端口边界，修正自交、零面积或不相等的 bbox；工具不扩大端口以求连接。 |
| 多个分量 / missing seed | 检查多个 figure 是否确属一个 terminal、是否确实接触导体，以及 VIA 端点规则；不会自动跨空隙接线。 |
| 已有输出 / duplicate pin | 选择新输出名；不要重复应用已经写入的注解。 |

注解确认了 pin 身份和几何，**没有证明设备边界与工艺规则完整**。GDS 缺少器件
语义时，Physical 结果可能仍标记 limited；这是需要技术证据的另一问题。见
[追踪合同](NET_TRACING_PLAN.md#interpreting-incomplete-rules) 与
[具体处理表](USAGE.md#看到不完整后如何处理)。不要为了去掉提示而虚报完整性。
