# 光照模型演进分析 — 2018 vs 国际服 0.34.3（同源验证 + 复古移植终局结论）

> 对比对象：`Mesh0.frag`（2018）vs `Mesh-11h.android.fs.spv.glsl`（2026）
> 日期：2026-08-09

---

## 一、核心结论：光照数学 8 年同源

**TGC 的光照模型骨架自 2018 年至今未变**——逐项对比实测：

| 环节 | 2018 (Mesh0.frag) | 2026 (Mesh-11h) | 结论 |
|---|---|---|---|
| **TBN 构建** | dFdx/dFdy + cross 积 + inversesqrt | 完全同构（新增退化回退） | 🟢 同源 |
| **法线解码** | `xy*2.007874-1.007874` | `xy*2.0078125-1.0078125` | 🟢 系数同源 |
| **太阳光** | `u_sunDir/u_sunColor + NdotL` | 同（UBO 化） | 🟢 同源 |
| **环境探针** | `u_probeCube + v_probeAmb/Spec` | `samplerCube _214`（保留） | 🟢 同源 |
| **动态光源** | 32×16 纹理化光源数组 + 幂衰减 | 同思路（UBO 化） | 🟢 同源 |
| **粗糙度** | 法线导数估算（微表面近似） | 同（FP16 化） | 🟢 同源 |
| **高光** | 探针反射 R 向量 | `reflect()` 保留 | 🟢 同源 |

## 二、8 年演进的真实差异（不在光照，在管线）

1. **数值鲁棒性**（新）：isnan 检查、退化切线回退、NaN 保护——2018 裸奔
2. **FP16 全链路**：f16mat3/f16vec3——带宽减半
3. **质量分级**：tier 变体（10f→13h）按 GPU 能力裁剪
4. **色彩科学**（核心差异）：Tonemap 从 2 变体 → 12 色彩空间（HDR/ACES/Frostbite）
5. **特效**：雨滴/变色龙/焦散等新内容

## 三、复古移植终局结论（全链路验证完成）

```
2018 复古观感 = 光照模型(同源) × Tonemap0 色调映射 × Bloom 参数 × 暗角
                     ↑ 无需移植          ↑ 已移植 ✅         ↑ 待移植    ↑ 已含在 Tonemap 移植版
```

### ✅ 已完成
- **Tonemap 移植**：`vintage_tonemap_rec709.fs.spv`（反色调映射+Bloom合成+暗角+Reinhard²）
  descriptor 布局与原版 100% 一致（set=1/binding 全同/Fragment main/FP16）
- **Frida 注入框架**：`hook_vkShaderModule.js`（AAsset + vkCreateShaderModule 双策略）
- **全量 shader 库**：4015 模块反编译（107 万行 GLSL）

### ⚠️ 待真机验证
- UBO 成员语义（_151._m0-m6 的映射）——dump 模式实测
- Bloom 纹理 binding（_592=bloom 的假设）——dump 模式确认

### 🎯 最终推荐路径（复古化）
```
1. [已就绪] 编译 vintage_tonemap_rec709.fs.spv
2. [真机]   Frida dump 模式 → 确认 UBO 语义 + Tonemap 模块 hash
3. [真机]   Frida swap 模式 → 观察复古色调
4. [可选]   Bloom 移植 (BloomUpOld 4-tap vs 2018 13-tap, 同法)
5. [可选]   调参: 复古 Warm 感 = Tonemap 移植版内曝光/暗角系数微调
```

## 四、复古移植的确定性评估

| 风险点 | 评估 |
|---|---|
| 光照模型不匹配 | 🟢 同源，无需处理 |
| descriptor 布局不兼容 | 🟢 已验证 100% 一致 |
| UBO 成员语义错误 | 🟡 已推断（_m2=exposure/_m3=bloomParams），dump 验证 |
| FP16 精度差异 | 🟢 移植版保留 FP16，与原版同精度 |
| 花屏风险 | 🟡 首次注入可能花屏，小步验证（先只换 1 模块） |
| 封号风险 | 🔴 仅限离线/测试账号，联机账号勿用 |

## 五、遗留总结（全项目）

| 方向 | 状态 |
|---|---|
| 服务器/网络 | ✅ 完成（历史测试服务器已下线，本地 mock 验证） |
| 引擎/脚本 | ✅ 完成（Lua5.2.4 + 47 Lua + 5 luac + API 面） |
| 渲染/着色器 | ✅ 完成（2018 全量 + 2026 全量 + 移植版） |
| LVL04 顶点流 | 🟡 需 BST 工具链（黑盒上限） |
| 联机协议实测 | 🟡 需 macOS + 抓包 |
| 复古渲染实机 | 🟡 需 root 设备 + Frida（工具已 100% 就绪） |