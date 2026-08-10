# 2018 复古渲染 → 国际服 0.34.3 移植指南（SPIRV-Cross 实战版）

> 基于完整工具链实测：SPIRV-Cross 反编译 → 2018 逻辑移植 → 编译/注入
> 前置：`16_intl_v0343_render_diff.md`（架构差异总览）
> ✅ 更新：**编译闭环已打通，接口一致性已实测验证通过（2026-08-09）**

---

## 一、工具链（本机已就绪 ✅ 全部原生 aarch64）

| 工具 | 位置 | 状态 |
|---|---|---|
| **spirv-cross** | `/tmp/SPIRV-Cross-main/build/spirv-cross` | ✅ 源码编译成功 |
| **spirv-dis / spirv-as** | `/usr/bin/`（spirv-tools 2025.1，apt 安装） | ✅ 反汇编/汇编 |
| **glslangValidator** | `/usr/bin/`（glslang 15.1.0，apt 安装） | ✅ GLSL→SPIR-V 编译 |
| **spirv_info.py** | `_analysis/spirv_info.py` | ✅ 轻量解析后备 |
| **hook_vkShaderModule.js** | `_analysis/hook_vkShaderModule.js` | ✅ Frida 注入框架 |
| **vintage_tonemap_rec709.fs.glsl** | `_analysis/` | ✅ 移植版源码（已修 set=1） |
| **vintage_tonemap_rec709.fs.spv** | `_analysis/`（16,412 B） | ✅ **编译产物，可替换** |

> 注：apt 源已从失效的清华镜像切换到 `ports.ubuntu.com`；glslang 官方 x86_64
> 包与 aarch64 本机不兼容，改走 apt 原生包。

## 二、反编译成果（50 个核心 shader）

`_analysis/intl_shaders_glsl/` 覆盖完整渲染链：
- **Tonemap** ×3 变体（rec709/rec709_sRGB/movie）— 已完整还原
- **Bloom** ×2（DownOld/UpOld 老版本，与 2018 同思路）
- **Ocean** ×12 变体（Cinema/Dark/Mesh/Wet/FoamLine/Orbit/NearSurfacePatch）
- **CloudFluffy** ×2（fs 477 行 + cs 计算版 395 行）
- MotionBlur / FogVolume / Sun / TemporalAa / Fxaa / WaterSim(fs+cs)

## 三、2026 Tonemap 完整逻辑还原（Tonemap_rec709 fs）

```
输入:  _576(bind3)=场景   _490(bind7)=畸变表   _592(bind5)   _376(bind4)   _709(bind6)=量化
UBO:   _113(bind2)=99成员巨型块   _151(bind0)=7成员小块
管线:
 1. UV 镜头畸变修正 (采样 _490)
 2. 色差/边晕修正 (_113._m3/_m4)
 3. ★ ACES 电影曲线: x*(x*2.4+0) / (x*(x*2.35/exposure+1.2)+0.1)
 4. ★ Frostbite tone: pow(x,2)*exposure → 1-exp(...)
 5. smoothstep 混合 + 色域矩阵 (_113._m34-_m39 为 REC709 3x3)
 6. 蓝噪抖动: dot(vec2(171,231), fragCoord)
 7. RGB565 量化 + 位掩码混合 (dithering)
```

## 四、2018 复古移植（核心交付）

**vintage_tonemap_rec709.fs.glsl** 以 2026 骨架为外壳、2018 逻辑为内胆：

| 段 | 2026 原版 | 2018 复古版 |
|---|---|---|
| 畸变修正 | 保留 | 保留 |
| 主色调映射 | ACES+Frostbite 曲线 | `1/max(0.0001,x)-1` 反色调映射 |
| Bloom 合成 | 内联 | `(0.25-bp.x*0.25)*full + bloomTex*tint*(bp.x+bp.y)` |
| 暗角 | 无 | 椭圆暗角（0.625/0.97 参数） |
| 压缩 | ACES | Reinhard² `(x/(x+0.25))²` |
| 抖动/量化 | 保留 | 保留（画质提升） |

### UBO 成员映射（需真机验证）
```
_151._m0 = 场景增益 vec3        (2018 无 → 恒 1.0)
_151._m1 = 灰度混合系数          (2018 无 → 0.0)
_151._m2 = u_exposure
_151._m3 = u_bloomParams (x=混合, y=强度)
_151._m4/_m5 = 开关 (2018 无 → 0)
_151._m6 = 量化参数 (保留)
纹理: _576=场景, _592=bloom, _376=motionBlur, _490=畸变表, _709=量化
```

## 五、替换执行路径（实测路线）

### 路径 A：Frida 运行时注入（推荐，免改包）
```bash
# 1. 编译移植版 → SPIR-V
glslangValidator -V vintage_tonemap_rec709.fs.glsl -o vintage.fs.spv
adb push vintage.fs.spv /data/local/tmp/

# 2. dump 模式: 定位目标模块 hash
frida -U -f com.tgc.sky.android -l hook_vkShaderModule.js --no-pause   # MODE=dump
# 输出: [VK] CreateShaderModule size=18852 fp=xxxxxxxx ...

# 3. 填入 TARGET_HASH, 切 MODE=swap, 重新注入
frida -U -f com.tgc.sky.android -l hook_vkShaderModule.js --no-pause
```

### 路径 B：打包替换（无 root 设备）
```bash
# 解包 APK → 替换 assets/Data/Shaders/Bin/Tonemap_rec709-11h.android.fs.spv
# (需保证新 SPIR-V 与原模块: 入口 main + Fragment 执行模型 + descriptor 布局一致)
apktool d Sky.apk
cp vintage.fs.spv Sky/assets/Data/Shaders/Bin/Tonemap_rec709-11h.android.fs.spv
apktool b Sky -o Sky_mod.apk
zipalign -f 4 Sky_mod.apk Sky_aligned.apk
apksigner sign --ks my.keystore Sky_aligned.apk
```

### 路径 C：参数级验证（先确认方向）
```bash
# 改 Vars.lua 曝光/色调参数, 观察是否接近 2018 观感
# 国际服: assets/Data/Vars/Vars.lua (明文)
```

## 六、风险与合规

1. **合规**: 修改客户端违反 TGC 服务条款, 仅限离线研究/个人设备
2. **封号风险**: 国际服反作弊 + 服务端校验, 联机账号勿用
3. **技术风险**: UBO 成员映射为推断, 真机验证前可能花屏 — 用 dump 模式先记录, 小步验证
4. **替换粒度**: 先只换 Tonemap 1 个模块验证 → 成功后再扩 Bloom/CloudFluffy

## 七、下一步可做

- [ ] 修复 glslangValidator 动态库依赖 (ldd 检查缺 libtinfo/libc), 打通编译闭环
- [ ] dump 模式实机运行, 收集全部模块 hash + 确认 UBO 成员语义
- [ ] 反编译剩余 1965 个新增 shader 建立完整索引 (批量脚本已就绪)
- [ ] BloomUpOld/CloudFluffy 的 2018 移植版 (与 Tonemap 同法)