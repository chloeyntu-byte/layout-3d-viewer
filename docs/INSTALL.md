# VL3D 安装与部署

## 1. 最小依赖

- Node.js 18 或更高版本。
- Python 3.6 或更高版本，以及与该 Python 匹配的系统 Tk。
- Linux 原生界面需要 X11/XWayland 和可创建 OpenGL 2.1/GLX context 的显卡驱动或 Mesa 软件栈；Tk display 通过不代表 GL context 一定可用。
- 发布包已内置固定版本、发布时校验的精简 Three.js 模块，生产启动不需要 `npm install` 或 `node_modules`。
- OA 加载另需可用的 Cadence/Virtuoso、license、`cds.lib` 或 `lib.defs`，以及用于初始化站点环境的 shell 脚本。
- GDSII/OASIS 默认由 gdstk 导入；数字层号需要用户提供的 layer map 或 profile（见 `docs/LAYER_PROFILES.md`），仅在唯一高置信签名时才自动应用，完整 KLayout 仅作为兼容回退。
- 原生客户端使用 Tk 自带文件对话框；zenity/kdialog/yad 只服务旧浏览器兼容端。

生产安装：

```bash
./bin/vl3d doctor
./bin/vl3d setup --native --install
./bin/vl3d gui
```

原生 setup 在 `$XDG_DATA_HOME/vl3d/native-venv` 创建不继承系统 site-packages 的隔离环境；它不升级系统 Python，也不写 OA/PDK 目录。若报 `VL3D-E1012`，先安装系统 Tk（RHEL/CentOS 7 通常为 `python3-tkinter`）；`VL3D-E1013` 表示隔离环境中的 Python 包缺失或不兼容。

完全离线时，先在相同 Python minor、操作系统和 CPU 架构的联网机器生成完整 wheelhouse。Python 3.6 使用：

```bash
python3 -m pip download -d /path/to/wheels --prefer-binary \
  --only-binary numpy,gdstk,ijson \
  'pip==21.3.1' 'setuptools==59.6.0' 'wheel==0.37.1' \
  -r requirements-native.txt
./bin/vl3d setup --native --install --wheelhouse /path/to/wheels
```

Python 3.8 及以上将前三个约束替换为 `pip>=24,<27`、`setuptools>=68,<83`、`wheel>=0.42,<1`。wheelhouse 必须同时包含这三个 bootstrap wheel 和 `requirements-native.txt` 的全部依赖；setup 会强制 `--no-index`，不会偷偷访问网络。

仅开发、测试或维护发布包时才执行 `npm ci`。项目使用 `playwright-core` 调用系统已有浏览器，不自动下载 Chromium。

## 2. 自动检测与首次配置

先让 doctor 检查路径、权限、端口和可选工具：

```bash
./bin/vl3d doctor --library /path/to/OA_library
./bin/vl3d doctor --library /path/to/OA_library --json
```

预览配置不会改文件：

```bash
./bin/vl3d setup --library /path/to/OA_library
```

确认诊断结果后，显式保存到 XDG 用户配置：

```bash
./bin/vl3d setup --library /path/to/OA_library --write
```

默认配置位于 `$XDG_CONFIG_HOME/vl3d/config.json`，未设置 XDG 时使用 `~/.config/vl3d/config.json`。运行数据位于 `$XDG_CACHE_HOME/vl3d/data`，状态和日志位于 `$XDG_STATE_HOME/vl3d`，不会写入源码目录。

配置优先级固定为：命令行参数、`VL3D_*` 环境变量、XDG 用户配置、项目旁的 `vl3d.config.json`、自动检测。UI 中的 `Load Library` 和高级设置仍可覆盖自动检测；持久化值保存在同一 XDG 配置，覆盖前生成时间戳备份。

直接打开 GDS/OAS 时，显式 layer map / PDK profile 同样优先。数字层号没有跨 PDK 的统一意义；只有数字相似而没有工艺或命名证据时，保持 generic，并提示在 Advanced 指定 profile 或 layer map。首次体验可直接打开公开合成示例 `examples/hierarchy-demo.json`。

## 3. 手动覆盖

自动检测不明确时使用以下参数：

```bash
./bin/vl3d doctor \
  --cds-lib /path/to/cds.lib \
  --cadence-env /path/to/cadence_env.sh \
  --virtuoso /path/to/virtuoso \
  --python /path/to/python3 \
  --klayout /path/to/klayout
```

常用环境变量包括：

- `VL3D_CONFIG`、`VL3D_ROOT`、`VL3D_LIBRARY`
- `VL3D_CDS_LIB`、`VL3D_CADENCE_ENV`、`VL3D_VIRTUOSO`
- `VL3D_NODE`、`VL3D_PYTHON`、`VL3D_KLAYOUT`、`VL3D_BROWSER`、`VL3D_FILE_PICKER`
- `VL3D_NATIVE_PYTHON`、`VL3D_NATIVE_VENV`、`VL3D_WHEELHOUSE`
- `VL3D_PDK_PROFILE`、`VL3D_PDK_PROFILE_DIR`、`VL3D_PDK_PROFILE_DIRS`
- `VL3D_RESOURCE_MODE`、`VL3D_STREAM_LAYER_MAP`
- `VL3D_HOST`、`VL3D_PORT`、`VL3D_ENABLE_OA`
- `VL3D_CONFIG_DIR`、`VL3D_CACHE_DIR`、`VL3D_STATE_DIR`、`VL3D_DATA_DIR`
- `CDS_LIC_FILE` 或 `LM_LICENSE_FILE`

完整字段模板见 `vl3d.config.example.json`。不要把真实 library 路径、license 或站点环境文件提交到仓库。

## 4. 启动

启动前再次做 preflight，然后运行原生桌面客户端：

```bash
./bin/vl3d gui
```

仅查看启动计划：

```bash
./bin/vl3d gui --dry-run
```

不使用 OA 时可启动纯静态/stream 模式：

```bash
./bin/vl3d gui --no-oa
```

原生启动器创建随机 loopback 端口和每次启动随机 Bearer，并通过匿名管道将密钥交给 GUI；密钥不进入参数、环境、日志或磁盘，GUI 退出后后端随控制管道关闭。旧浏览器兼容端使用 `./bin/vl3d web`，同样不得暴露到公共网络。

## 5. 低资源机器

推荐在用户配置中使用：

```json
{
  "schemaVersion": 1,
  "resourceMode": "low"
}
```

`low` 限制单次 OA 展开规模，优先避免内存耗尽；`balanced` 是默认值；仅在有足够内存且布局确实需要时使用 `large`。缓存位于 XDG 目录，可单独迁移到容量更大的磁盘：

```bash
export VL3D_DATA_DIR=/path/to/vl3d-data
export VL3D_STATE_DIR=/path/to/vl3d-state
```

不要复制 `node_modules` 或原生 venv 到另一台机器。新环境直接使用发布包，并重新执行 `./bin/vl3d setup --native --install`，避免 Python ABI 污染。

`npm run build:stress` 只用于合成压力布局，默认原子替换输出且不保留旧副本；确需留档时显式追加 `-- --backup`。这样反复做四倍 VCO 压力回归时不会持续占用状态盘。

## 6. 验证

快速、无浏览器测试：

```bash
npm test
```

它覆盖 Node 运行路径、library session、私有后端、原生编译/缓存/交互、PDK 和 stream preflight。完整 GDSII/OASIS 测试优先使用 gdstk，并在可用时覆盖 KLayout 回退：

```bash
npm run test:stream
```

浏览器性能和交互验证与快速测试分离。先启动装有测试 layout 的服务，再运行：

```bash
CHROMIUM_BIN=/path/to/chromium npm run test:browser -- \
  --url http://127.0.0.1:5177/ --profile inv --no-screenshot
```

该命令不会下载浏览器。默认浏览器测试使用自包含 mock，不应导出真实 OA；只有显式 `--with-oa-integration` 才允许访问所选 library。

## 7. 发布审计

生成经过严格白名单过滤的源码目录和压缩包：

```bash
npm run release:build
npm pack --dry-run
```

发布器先在临时目录完整构建，再替换目标；同时生成 `MANIFEST.sha256`。它拒绝运行数据、备份、导出、截图、报告、真实 Cadence 配置、机器专属路径、符号链接和异常大文件。

故障代码、定位步骤和推荐修复见 `docs/TROUBLESHOOTING.md`，也可在运行中的 `/public/errors.html` 按错误码查询。
