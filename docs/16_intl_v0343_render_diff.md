# 国际服 0.34.3 渲染/着色器实测分析 — 与 2018 全面差异报告

> 分析对象：`Sky_0.34.3 (408160)/`（国际服安卓 arm64 APK 解包，2026 版）
> 对比基准：`Sky.app`（2018 macOS 内测版）
> 日期：2026-08-09

---

## 一、国际服 0.34.3 渲染栈（实测结论）

| 维度 | 实测结果 |
|---|---|
| **图形 API** | **Vulkan**（libBootloader.so 含 107 个 VK_ 符号） |
| **shader 格式** | **SPIR-V 1.3**（4015 个，魔数 `07230203`，生成器 shaderc 0xD000B） |
| **调试信息** | **OpName 全部 strip**（名称不可见，仅保留入口点 "main"） |
| **绑定模型** | **UBO + Descriptor Set**（Vulkan 规范，非 GLSL uniform 直绑） |
| **计算着色器** | **60 个 .cs.spv**（云体积/水仿真迁移到 GPU Compute） |
| **纹理** | **KTX 压缩纹理**（696 个，替代 2018 的 PNG） |
| **体积纹理** | .vol 保留（CloudFluffy/CloudNoise/PerlinNoise 与 2018 相同） |
| **Tonemap** | **12 个色彩空间变体**（HDR10-PQ / rec2020 / DCI-P3 / 电影 / 截图） |

## 二、shader 资产规模对比（2018 → 2026）

| 指标 | 2018 | 2026 国际服 | 倍数 |
|---|---|---|---|
| 唯一 shader 名 | 209 | 2005 | **9.6×** |
| 源文件 | 332 (GLSL 明文) | 4015 (SPIR-V) | 12× |
| 计算着色器 | 0 | 60 | — |
| 渲染声明 | 156 | — | — |
| 纹理 | 367 PNG | 696 KTX | 1.9× |
| 网格 | 249+ | 6862 | ~27× |
| 关卡文件 | 249 | 339 | 1.36× |
| 体积纹理 | 3 | 3 | 1× |

## 三、同名 shader（40 个，渲染骨架保留）

Avatar, CloudCard, CloudFluffy, FogUpsample, FogVolume, Fxaa, Mesh,
MeshMotion, MotionBlur, MotionDilate, MotionDownsample, MotionGen, Ocean,
Sprite, Sun, TemporalAa, WaterSim, WaterSimReset, ...

## 四、重大架构升级（2018 → 2026）

### 4.1 渲染管线重构
```
2018:  GLSL ES300 明文 → GLES3 → 引擎运行时编译
2026:  SPIR-V 1.3 预编译 → Vulkan → 引擎直接加载
       接口: uniform 直绑          →  UBO + descriptor set
       调试: 保留 uniform 名        →  名称全 strip
```

### 4.2 计算着色器引入（60 个）
- `CloudFluffy*.cs` — 体积云改 GPU compute 仿真（含 InfiniteScroll/Undulate 变体）
- `WaterSim*.cs` — 水面模拟 compute（MultiIndent 变体）
- `CloudDepth.cs` / `CloudComplexity.cs` — 云深度/复杂度分析
- 2018 时代这些逻辑在 fragment shader 中，2026 独立成 compute pass

### 4.3 HDR 色彩管线（Tonemap 12 变体）
```
Tonemap_movie / Tonemap_movie_hdr / Tonemap_p3_dci / Tonemap_p3_display /
Tonemap_p3_display_pq / Tonemap_p3_linear / Tonemap_rec2020_pq /
Tonemap_rec709 / Tonemap_rec709_sRGB / Tonemap_screenshot(_hdr)
```
→ 支持 HDR10 (PQ)、DCI-P3、REC2020 色域 —— 2018 仅有 2 个变体（彩色/BW）

### 4.4 8 年内容扩张（新增 shader 特征）
- 角色: AvatarHair(毛发)/AvatarOceanCaustics(海洋焦散)/AvatarClipped
- 环境: Anni4Light/AnniversaryDanceLamp(周年庆)/DiscoLightGround
- 特效: BrushstrokeColorSampleFragSSBO(笔触SSBO)/JellyfishMotion(水母)
- 系统: VisibilityQueryMinFragSSBO/VisibilityDown(可见性查询SSBO)/Instanced*(实例化)
- MeshPlaceableProp*(可放置物)

## 五、替换方案更新（基于实测修正）

### ❌ 路线①（GLSL 直换）— 已失效
2018 的 .vert/.frag 是明文 GLSL，2026 是 strip 名称的 SPIR-V——**不可直接覆盖**。

### ⚠️ 路线②（SPIRV-Cross 重编译）— 可行但需接口匹配
```
1. SPIRV-Cross 反编译国际服 SPIR-V → GLSL (恢复可读性)
2. 提取 UBO 布局 / descriptor set / push constant 结构   ← 关键
3. 用 2018 逻辑改写 shader 函数体 (保留 2026 接口骨架)
4. glslangValidator -V 重编译 → SPIR-V
5. 替换 .spv 文件 → 重打包/重签名
```
- 工作量：集中在"接口适配层"（UBO 成员偏移/descriptor 绑定）
- 成功关键：反编译后的 GLSL 必须能还原 UBO 结构（spirv_info.py 已能提取 binding/Block）

### ✅ 路线③（Frida vkCreateShaderModule 注入）— 2026 版新机会
Vulkan 的 shader 模块化特性使运行时替换比 GLES 更干净：
```javascript
// hook vkCreateShaderModule: 拦截 pCreateInfo->pCode (SPIR-V 指针)
// 替换为 2018 逻辑编译的 SPIR-V (需匹配 entry point "main" + descriptor 布局)
```
- 优点：不改包/不重签/可热切换/支持 A/B 对比
- 缺点：需 root + 每次启动注入

### ✅ 路线④（参数级 Vars.lua）— 仍最稳
国际服保留 `Vars.lua/Vars_Live/Vars_Test/Vars_Stabilization`（明文！）
- 改光照角度/色调/后处理开关等渲染参数
- 零风险、不碰 shader、随时回滚
- 注意：国际服 Vars.lua 键名可能与 2018 不同，需 diff 后适配

## 六、配套工具（_analysis/）

| 工具 | 用途 |
|---|---|
| `spirv_info.py` | 轻量 SPIR-V 解析器（OpName/EntryPoint/UBO Block/descriptor binding） |
| `intl_shader_names.txt` | 国际服 2005 个 shader 基名清单 |
| `intl_common_2018.txt` | 40 个同名 shader（骨架对照） |
| `intl_new_only.txt` | 1965 个新增 shader |
| `intl_removed_2018.txt` | 21 个 2018 独有 shader |
| `shaders/Bin/*.frag` | 2018 GLSL 源（改写参考） |
| `15_android_replace_guide.md` | 安卓替换手册（需按本报告更新路线） |

## 七、推荐执行路径（最终版）

```
优先:  路线④ Vars.lua 参数级调色 (验证"复古观感"方向是否正确)
其次:  路线③ Frida vkCreateShaderModule 注入 (Tonemap_rec709 定向替换, A/B 对比)
最后:  路线② SPIRV-Cross 全量移植 (需先完成 UBO 布局逆向, 工作量大)
避免:  路线① 直接覆盖 (格式不兼容, 已证实不可行)
```

## 八、结论

1. **2018 与 2026 是两代渲染架构**：GLES3+GLSL → Vulkan+SPIR-V，接口模型全变
2. **视觉骨架同源**：40 个核心 shader 名保留，说明渲染理念延续（云/水/角色/后处理）
3. **"复古光效"替换的现实路径**：先参数级验证 → 再 SPIR-V 级定点移植（Tonemap 是首选目标，
   2018 的 `1/x-1 反色调映射 + Reinhard² + 暗角` 逻辑可直接翻译进 2026 的 SPIR-V 函数体）
4. **合规**：修改客户端违反 TGC 条款，仅限离线研究