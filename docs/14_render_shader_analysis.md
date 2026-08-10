# Sky Gold 2018 — 渲染与着色器完整分析 + 国服替换方案

> 来源：`Sky.LA(2018)/Sky.app` 全量提取 + 反汇编 + Lua 源码分析 (2026-08)

---

## PART A. 2018 版渲染/着色器资产全提取

### A1. 资产清单（已归档至 `_analysis/shaders/`）

| 资产 | 数量 | 说明 |
|---|---|---|
| **Shader 声明** | 156 个 | `resource "Shader"` Lua DSL（Boot.lua 为核心） |
| **唯一 shader 名** | 209 | Avatar/Bird/Bloom/Cloud*/Mesh/Ocean/Water/Grass/Sand... |
| **GLSL 源** | 332（160 vert + 172 frag） | **明文 `#version 300 es` 源码**（Unity ShaderLab 编译器输出） |
| **Metal 编译产物** | 334 `.metallib` | 魔数 `MTLB`，命名 `Name<哈希>.{vert,frag}.osx.metallib` |
| **纹理** | 367 PNG（Images/Bin/）+ 3 `.vol` | 2D 贴图 + 3D 噪声体积纹理 |
| **体积纹理** | PerlinNoise / CloudFluffy / CloudNoise | 云/噪声渲染 |

### A2. 渲染架构（三层管线）

```
① Shader 源 (Unity ShaderLab, 美术侧)
   ↓ Unity Shader 编译器
② GLSL ES 300 中间码 (.vert/.frag, 包内明文)   ← 引擎加载格式
   ↓ TGC 着色器编译器 (离线, Jenkins)
③ Metal AIR 二进制 (.metallib, 运行时加载)
   ↓ MetalRenderer (TGC 自研 Metal 封装)
④ GPU 执行
```
- 引擎类证据：`MetalRenderer/MetalShader/MetalTexture/MetalBuffer/MetalCommandBuffer/
  MetalComputePipeline/MetalRenderPass/MetalRenderPipeline/MetalResourceTable/MetalSampler`
- **关键结论：GLSL ES300 是跨平台中间格式** → 同一套源可重编译到 Metal/GLES/Vulkan
  （国服移动端 Android 即 GLES/Vulkan 后端，PC 版为另一平台后端）

### A3. 渲染管线（Boot.lua 还原，完整后处理链）

```
场景渲染 →
  DepthDownsample (Metal 变体×3, 半/四分之一分辨率)
  CloudFluffy (SuperCoarse/Coarse/Fine 3级) + FogVolume + FogUpsample(Cheap)
  MotionGen/Disabled → MotionDilate → MotionDownsample → MotionBlur
  Bloom (DownFirst/Down×2/Up/UpLast, instanceLimit=16)
  Tonemap (+BW 黑白变体)
  TemporalAa / Fxaa (+Disabled)    ← TAA 与 FXAA 二选一
  Scanout (LensDistortion 镜头畸变, 用于 VR/移动)
```

### A4. 渲染组体系（group 分类，决定绘制顺序/混合）

| 组 | shader 示例 |
|---|---|
| Opaque | Candle/CloudCore/Mesh/MeshSh/Cham... |
| Blended | Beacon/Bub/CloudQuadFast/Flame/Flower... |
| AlphaTestOpaque | BirdFlock/GrassSh/SandSh/RockFaceSh... |
| Decal | AncestorEngine/MeshChamSh (SDF 贴花) |
| Cloud | CloudCard (软粒子云) |
| FogVolume | FogVolume (体积雾) |
| BlendedBackground | CandleAura |
| BlendedWithBackfaces | ChamAlphaDepth |
| LensDistortion | Scanout (屏幕后处理) |

### A5. 着色器目录（209 名，功能分组）

- **角色/生物**：Avatar(×6变体)/Bird/Creature/CharBirdAnim/Candle/CandleAura/Flame/Flower/HeartAura/Bub/Beacon
- **网格基础**：Mesh/MeshSh/MeshSl/MeshMotion/MeshChamSh/StaticMeshMotion/LitAlpha/LitAlphaTest/UnlitAlpha/Sprite
- **天空/云**：SkyboxCloud/CloudCard/CloudCore/CloudFluffy(×3)/CloudSh(×3)/FlatCloud/CloudQuad(×4)/CircleMotionGraphics
- **地形/地表**：Terrain/GrassSh(×3)/SandSh(×3)/RockFaceSh(×3)/DarkStone/DarkstoneRain
- **海洋/水体**：Ocean/OceanMesh/WaterSim/WaterSimClear/WaterSimComp/WaterSimReset/PuddleSim/PuddleDrop
- **后处理**：Resample/DepthDownsample(×6)/Bloom(×4)/FogVolume/FogUpsample(×2)/Motion*(×6)/Tonemap(×2)/TemporalAa/Fxaa(×2)/Scanout
- **工具/UI**：HudMask/MovieFrame/Screenshot/ColorSprite(×4)/SpriteFramebuffer/Sun/LensFlare

### A6. 材质与对象绑定机制

- TGCL 对象属性（989 schema 中的渲染相关）：
  `shaderName / meshName / textureName / material / materialBstGuid / materialBstGuidSecondary /
  shaderParams / useCustomShader / color / colorMin / colorMax / baseColor / sunColor /
  meshType / materialAngle / materialAngleGradient / materialTop / materialBottom /
  spriteTextureRegion / starCreatureMesh / valTexture / fadeTexture`
- **绑定链**：`TGCL对象.shaderName` → `resource "Shader" 声明` → `vs/fs GLSL源` → `metallib`；
  `materialBstGuid` = BST 工具链材质 GUID（烘焙时生成）
- Mesh：`.fbx` 源 → LevelCompiler 烘焙 → LVL04（`computeOcclusions/registerCollision/stripAnimation` 参数）

### A7. 纹理体系
- Images/Bin/*.png（365，2D 贴图：UI/贴花/粒子/环境）
- Tex3D/*.vol（3D 噪声：PerlinNoise/CloudFluffy/CloudNoise → 云体积渲染）

---

## PART B. 替换到国服最新版方案分析

### B1. 国服渲染栈推断（基于 TGC 技术一致性）

国服《光·遇》（网易代理，iOS/Android/PC）沿用 TGC 自研引擎（AncestorEngine 跨平台版），
渲染栈大概率与 2018 版同源：

| 平台 | 后端 | shader 形态（推断） |
|---|---|---|
| iOS | Metal | `.metallib`（同 2018 macOS） |
| Android | GLES3/Vulkan | GLSL ES300 源 or SPIR-V |
| PC (网易) | DX11/DX12 或 Vulkan | HLSL/DXBC or SPIR-V |

**关键前提**：若国服包仍保留 GLSL ES300 中间源（或等价中间格式），则替换原理与 2018 版一致；
若已改为各平台原生格式（如只发 metallib/SPIR-V），则需按目标平台重编译。

### B2. 替换路径（三条路线）

**路线① 同管线替换（推荐，成功率最高）**
- 目标：把 2018 版"旧视觉"（或反向把国服新视觉移植回研究）替换进国服
- 前提：能提取国服 shader 中间源（需解包国服资源，网易运营包通常有加密/签名校验）
- 步骤：
  1. 解包国服（定位 Shaders 目录/等效路径）
  2. 确认国服 shader 中间格式（GLSL ES300 / SPIR-V / 平台二进制）
  3. 用 2018 版 GLSL 源覆盖同名 shader（注意 2018 与国服的 uniform/绑定差异）
  4. 走国服离线 shader 编译器重编译（需还原其编译配置，defines/instanceLimit/group）
  5. 重打包 + 绕过资源签名校验
- 风险：shader 语义差异（2018 用 `u_viewProj` 等 uniform，国服可能改名）；
  defines 组合（156 声明中多数有 defines）必须一致

**路线② 参数/配置级替换（最简单，无需动 shader 二进制）**
- 不替换 shader 文件，只改**渲染配置**：
  - `Vars.lua` 渲染参数（kSunAngleXZ/kSunAngleY 光照、色调）
  - 后处理开关（TemporalAa/Fxaa/Bloom/Fog 的 instanceLimit/defines 配置）
  - TGCL 对象属性（color/sunColor/materialAngle/emissive）
- 适用：想要 2018 版"暖色调旧版光效"而不动代码

**路线③ 跨管线移植（仅研究价值）**
- 2018 GLSL ES300 → 手工移植为国服目标格式（HLSL/SPIR-V）
- 需逐 shader 翻译 uniform/采样器/指令（工作量大，仅个别关键 shader 值得做）

### B3. 具体操作手册（若已拿到国服包）

```
1. 定位国服资源目录:  搜索 *.metallib/*.spv/*.frag/*.vert/*.hlsl
2. 提取 shader 清单:  对比 2018 的 shader_inventory.txt (209名)
3. 差异分析:          diff 同名 shader 的 defines/group/uniform 声明
4. 建立映射表:        2018名 ↔ 国服名 (可能改名, 需从材质GUID反查)
5. 选择替换策略:
   a. 全量替换 (视觉 100% 复古) — 需重编译全平台
   b. 关键 shader 替换 (只换 Cloud/Ocean/Tonemap/后处理) — 性价比高
   c. 参数级 (Vars/TGCL 属性) — 零风险
6. 重打包工具:  需逆向国服资源打包器 (TGCL 同源则用相同容器)
7. 绕过校验:    网易包通常有 CRC/签名/热更校验, 需 patch 或注入
```

### B4. 本包可直接复用的关键资产（替换素材）

| 素材 | 路径 | 用途 |
|---|---|---|
| 全部 GLSL shader 源 | `shaders/Bin/*.vert|*.frag` | 移植基础 |
| Shader 声明+defines | `shader_declarations.txt` | 编译配置还原 |
| 后处理链配置 | Boot.lua | 渲染管线对照 |
| 体积纹理 | Tex3D/*.vol | 云渲染素材 |
| 2D 纹理 | Images/Bin/*.png | 贴图素材 |
| 渲染参数 | Vars.lua (kSunAngle/kWindTumble...) | 参数级替换 |
| Mesh 绑定 | LVL04 + TGCL shaderName | 材质关联 |

### B5. 风险与合规提示

1. **技术风险**：2018 版 shader 与国服版 uniform 语义/常量绑定差异 → 需适配层；
   defines 编译矩阵不同 → 需按国服 pipeline 重编译
2. **法律合规**：国服《光·遇》由网易运营，替换/修改其客户端资源违反服务条款，
   仅建议用于个人技术研究、离线演示或学术分析；勿用于在线对战/商业用途
3. **签名/校验**：现代国服包有资源完整性校验，替换后大概率无法直接启动，需 patch

---

## 归档索引

| 文件 | 内容 |
|---|---|
| `shaders/` (666 文件, 7.6MB) | 全部 GLSL 源 + Metal metallib + vol 纹理 |
| `shader_inventory.txt` | 209 个唯一 shader 名清单 |
| `shader_declarations.txt` | 156 个 `resource "Shader"` 声明（含 defines/group） |
| `lua_source/Resources/Boot.lua` | 渲染管线声明（后处理链） |
| `07_tgcl_attribute_dict.txt` | TGCL 渲染属性 schema（shaderName/meshName/materialBstGuid） |
| `06_shader_list.txt` | 178 个引擎内嵌 shader 字符串清单（早期提取） |