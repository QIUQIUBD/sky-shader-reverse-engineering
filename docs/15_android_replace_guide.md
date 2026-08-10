# 安卓国际服《光·遇》渲染/着色器替换指南（2018 → 最新版）

> 基于 `_analysis/shaders/` 提取的 332 个 GLSL ES 300 源 + 156 个 shader 声明。
> 核心结论：**安卓 GLES3 后端的 shader 加载格式 = GLSL ES 300 = 2018 版包内格式**，
> 若国际服仍保留该格式 → **直接替换源文件即可生效，无需重编译**。

---

## 0. 前置准备

| 工具 | 用途 |
|---|---|
| 国际服 APK/XAPK | Google Play / APKPure / apkmirror 下载（与你的设备同架构） |
| Python3 | 检测脚本 |
| `detect_android_shaders.py` | 本目录，自动分析 APK shader 格式 |
| apksigner / zipalign | Android SDK build-tools（重打包签名） |
| 2018 资产 | 本目录 `shaders/Bin/*.vert|*.frag`（已就绪） |

## 1. 第一步：检测国际服 shader 格式（决定路线）

```bash
python3 detect_android_shaders.py /path/to/sky_international.apk
```

输出三种结论分支：

```
[A] "GLSL明文 (ES 300)"  → 路线① 直接替换（本指南主线）
[B] "SPIR-V"             → 路线② 需重编译（见 §5）
[C] "二进制(高熵/未知)"  → 路线③ 资源容器加密（见 §6）
```

若 APK 无独立 shader 文件：可能资源在 OBB/扩展包或 `assets/` 自定义容器，脚本会打印目录结构辅助定位。

## 2. 路线①：GLSL 明文直换（推荐，成功率最高）

### 2.1 解包
```bash
mkdir sky_apk && cd sky_apk
unzip ../sky_international.apk
# 或 (xapk): 先解出主 apk
```

### 2.2 定位并备份
```bash
find . -path '*shader*' -name '*.frag' | head -30   # 定位 Shaders 目录
# 找到后整目录备份:
cp -r <shader目录> ../shaders_backup
```

### 2.3 与 2018 清单对比
```bash
# 提取国际服 shader 名清单
ls <shader目录>/*.frag <shader目录>/*.vert | xargs -n1 basename | \
  sed 's/[0-9]*\.\(frag\|vert\)$//' | sort -u > ../intl_shaders.txt
# 与 2018 对比
comm -12 ../intl_shaders.txt shader_inventory.txt   # 同名(可直接替换)
comm -23 ../intl_shaders.txt shader_inventory.txt   # 国际服新增(勿动)
```

### 2.4 最小验证实验：替换 Tonemap（全局色调，肉眼最明显）

**目标文件**：国际服 shader 目录中名为 `Tonemap0.frag`（或含 Tonemap 的 frag）
**替换源**：`_analysis/shaders/Bin/Tonemap0.frag`（彩色版，复古暖橙）

```bash
# 1) 先对比 uniform 接口（关键! 若国际服改名需适配）
diff <(grep '^uniform' Tonemap0.frag) <(grep '^uniform' <国际服Tonemap.frag)
# 期望: u_bloomTint/u_bloomParams/u_exposure/u_texFull/u_bloomTex/u_texMotionBlur 一致

# 2) 替换（保留原文件名）
cp _analysis/shaders/Bin/Tonemap0.frag <国际服shader目录>/Tonemap0.frag
```

### 2.5 重打包 + 重签名（无 root 设备）
```bash
cd sky_apk
zip -r ../sky_mod.apk . -x 'META-INF/*'
# 删除旧签名
zip -d ../sky_mod.apk 'META-INF/*'
# 对齐+签名（SDK build-tools）
zipalign -f 4 ../sky_mod.apk ../sky_mod_aligned.apk
apksigner sign --ks ~/my.keystore --out ../sky_mod_signed.apk ../sky_mod_aligned.apk
# 安装
adb install ../sky_mod_signed.apk
```

**注意**：Android 应用有签名校验（应用内可能再次校验资源）。若闪退/校验失败：
- 检查 logcat：`adb logcat | grep -iE 'sky|shader|abort'`
- 或走 §7 的免打包验证方案

## 3. 关键 shader 替换清单（按优先级）

| 优先级 | shader | 视觉影响 | 替换文件 |
|---|---|---|---|
| ★★★ | **Tonemap** | 全局色调/曝光/暗角 | `Tonemap0.frag`（彩色） |
| ★★★ | **Bloom** | 发光强度/柔化 | `Bloom*.frag`（4 变体） |
| ★★☆ | **CloudFluffy/CloudSh** | 体积云形态 | `CloudFluffy*.frag` |
| ★★☆ | **Ocean/WaterSim** | 水面质感 | `Ocean*.frag` |
| ★★☆ | **Mesh/MeshSh** | 基础材质光照 | `Mesh*.frag`（注意：影响面广） |
| ★☆☆ | **GrassSh/SandSh/RockFaceSh** | 地表细节 | `GrassSh*.frag` |
| ★☆☆ | **Avatar/CandleAura** | 角色/烛光 | `Avatar*.frag` |

> ⚠️ 每个 shader 替换前必做 `diff uniform` 检查；defines 变体（156 声明中多数带 defines）
> 需确认国际服同名变体存在，否则替换后渲染错误（黑/粉屏）。

## 4. 2018 → 国际服 uniform 适配速查

| 2018 uniform | 常见国际服变化 | 适配 |
|---|---|---|
| `u_texFull/u_bloomTex/u_texMotionBlur` | 可能合并为 `u_tex0/u_tex1` | 重命名 + 绑定 |
| `u_viewportSize` (vec4: wh, 1/aspect) | 可能为 vec2 | 改类型 |
| `u_bloomParams` (vec4) | 可能拆为标量 | 拆分引用 |
| `u_exposure` | 可能改为 `u_ev100` | 换算 |
| `o_fragColor` | ES310 可同名 | 兼容 |

**建议策略**：优先替换"输入输出接口未变"的同名 shader；接口不同的先记入适配清单，用 Vars.lua 参数模拟效果。

## 5. 路线②：SPIR-V 分支

若检测为 SPIR-V（近年 Vulkan 化趋势）：
```bash
# 反编译回 GLSL (SPIRV-Cross)
spirv-cross --version 310 es <shader.spv> -o out.frag
# 用 2018 源替换逻辑后重新编译回 SPIR-V
glslangValidator -V -S frag out.frag -o new.spv
```
⚠️ 需匹配国际服 SPIR-V 的 binding/descriptor 布局，否则绑定错乱。

## 6. 路线③：资源加密分支

网易/官方若把 shader 打进加密容器（如自定义 .bin）：
1. 从二进制提取 shader 魔数定位（`#version`/SPIR-V 魔数 07230203）
2. 用 `strings` 探测 + 偏移分析找容器格式
3. 逆向加载器（IDA 分析 libSky.so 的 shader 加载函数）
> 此路线工作量大，建议先评估是否值得；或改走参数级替换（§7）。

## 7. 免打包验证方案（强烈建议先做）

不修改 APK，用 **GameGuardian / Xposed / Frida** 在运行时验证：

```bash
# Frida hook 方案 (需 root)
frida -U -f com.thatgamecompany.sky -l hook_shader.js
```
```javascript
// hook_shader.js 示例: 运行时拦截 glShaderSource, 替换 Tonemap 源码
Interceptor.attach(Module.findExportByName('libGLESv3.so','glShaderSource'), {
  onEnter(args) {
    const src = Memory.readCString(args[2].readPointer());
    if (src && src.indexOf('u_bloomParams') >= 0) {
      // 用 2018 Tonemap 源码替换 (从文件读入 JS 字符串)
      args[2].writePointer(Memory.allocUtf8String(TO_NEMAP_2018));
    }
  }
});
```
**优点**：不改包不重签、可随时开关、立即 A/B 对比；**缺点**：需 root，每次启动注入。

## 8. 风险与回滚

| 风险 | 现象 | 处理 |
|---|---|---|
| uniform 不匹配 | 黑屏/粉屏/异常色块 | 回滚该 shader（备份恢复） |
| defines 缺失 | 编译失败（logcat 报 shader link error） | 补 defines 或回滚 |
| 签名校验 | 启动闪退 | 走 §7 Frida 方案 |
| 版本热更 | 官方更新覆盖 assets | 更新后重新替换 |

**回滚**：备份目录整包恢复 + 重签即可。

## 9. 合规声明

- 仅用于个人技术研究/离线学习；国际服受 TGC 服务条款约束，修改客户端可能封号
- 不要用于在线对战、直播商业用途、传播修改包
- 推荐在本机离线环境（不联网）验证视觉效果

## 10. 配套工具索引

| 文件 | 说明 |
|---|---|
| `detect_android_shaders.py` | APK shader 格式检测 + 2018 对比 |
| `preview_2018_tonemap.html` | 浏览器实时预览 2018 Tonemap 视觉（无需游戏） |
| `shaders/Bin/*.vert|*.frag` | 2018 全部 GLSL 源（替换素材） |
| `shader_declarations.txt` | 156 个 shader 声明（defines/group 还原） |
| `shader_inventory.txt` | 209 个 shader 名清单（对比基准） |