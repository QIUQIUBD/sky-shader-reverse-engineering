# 国际服 0.34.3 全量 Shader 库分析 — 4015 模块完整索引

> 交付：`intl_shaders_glsl_full/`（4015 个 GLSL，107 万行）+ `shader_full_index.txt`
> 工具链：spirv-cross（源码编译）批量反编译全部 SPIR-V 1.3
> 日期：2026-08-09

---

## 一、库规模

| 指标 | 数值 |
|---|---|
| SPIR-V 模块 | 4015（100% 反编译成功） |
| GLSL 总行数 | **1,074,198** |
| 顶点 (vs) | 1995 |
| 片元 (fs) | 1960 |
| 计算 (cs) | 60 |

## 二、最复杂 shader Top10（新世代技术代表）

| 行数 | Shader | 技术特征 |
|---|---|---|
| 1285 | FogUpsampleScreenRainDrop | **屏幕空间雨滴雾效**（每帧雨滴轨迹+折射+雾散射） |
| 888 | AvatarChamNineColor | **变色龙皮肤**（九色渐变+虹彩） |
| 876 | FogUpsampleSaturationSpheres | 饱和度球体雾 |
| ~800 | Ocean* 系列（12 变体） | 海洋：法线+焦散+泡沫线+湿表面+近表面补丁 |
| 477 | CloudFluffy fs | 体积云（Raymarching 升级） |
| 395 | CloudFluffy cs | **云物理仿真 compute** |

## 三、变体体系（2018 → 2026 的核心架构演进）

**每个 shader 基名展开为 5 级质量 × 多变体**：
```
命名: <Base>-<variant><tier>.android.<stage>.spv
tier: 10f / 11f / 11h / 13f / 13h   (质量分级, f/h = 特性集)
变体: 同名 shader 的功能组合爆炸
```

| 基名 | 2026 变体数 | 说明 |
|---|---|---|
| **Mesh** | **450** | 网格主 shader（世界最大面数覆盖） |
| **Avatar** | **410** | 角色（含 ChamNineColor 皮肤等） |
| **Spirit** | 140 | 先祖灵体 |
| **Ocean** | 110 | 海洋（Cinema/Dark/Mesh/Wet/Foam/Orbit...） |
| **CloudFluffy** | 105 | 云（含 compute 变体） |
| **FogUpsample** | 90 | 雾上采样（含雨滴/饱和度球体特效） |
| **WaterSim** | 45 | 水仿真 compute |
| **DirectionalLighting** | 30 | 方向光 |
| Candle/CandleAura/Flower/DarkStone | 10-20 | 基础物件 |
| **2018 同名的 40 个基名全部存活** | — | 渲染骨架未删，仅扩展 |

## 四、技术代差总结（2018 GLSL → 2026 SPIR-V）

### 4.1 质量分级体系（新）
2018 无分级；2026 用 **tier 后缀**（10f/11f/11h/13f/13h）做
运行时的 GPU 能力适配——低端机用精简版，高端机用全特性版。

### 4.2 计算着色器（新，60 个）
云物理（CloudFluffy.cs）、水仿真（WaterSim.cs）、云深度/复杂度分析
——2018 时代全在 fragment 里，2026 迁移到 compute pass。

### 4.3 FP16 全链路（新）
全部 shader 用 `float16_t/f16vec*`（Vulkan 16 位浮点扩展），
带宽减半、性能翻倍——2018 只有 mediump 精度声明。

### 4.4 HDR 色彩管线（新）
Tonemap 12 变体（HDR10-PQ/rec2020/P3/电影），含蓝噪抖动+RGB565
量化（避免色带）——2018 仅有 2 个简单变体。

### 4.5 特效进化（新）
- **屏幕雨滴**（FogUpsampleScreenRainDrop 1285 行）
- **变色龙九色皮肤**（AvatarChamNineColor）
- **周年庆灯/三角**、海洋焦散、毛发、SSBO 可见性查询
- 2018 的 Bird/Grass/Sand/Terrain/Skybox 等旧 shader 已并入 Mesh/新体系

## 五、配套交付

| 资产 | 说明 |
|---|---|
| `intl_shaders_glsl_full/` | 4015 个 GLSL（文件名=原 SPIR-V 名） |
| `shader_full_index.txt` | 行数排序索引（4015 条） |
| `gen_shader_index.py` | 索引生成脚本 |
| `intl_shaders_glsl/` | 50 个核心 shader 精选反编译 |
| `vintage_tonemap_rec709.fs.glsl/.spv` | 2018 复古 Tonemap 移植版（已验证接口兼容） |
| `hook_vkShaderModule.js` | Frida 注入框架 |
| `spirv_info.py` | 轻量 SPIR-V 解析器 |

## 六、后续可做

1. **Mesh/Avatar 算法级对比**：2018 的 450 行 vs 2026 变体的差异（光照模型是否变化）
2. **雨滴/变色龙特效逆向**：新世代特效的完整数学还原
3. **tier 体系映射**：10f/11f/11h/13f/13h 对应机型分级表
4. **Vars.lua 渲染参数 diff**：2018 vs 2026 的调色参数变化（复古化的参数级路径）