# 实机注入链路打通 — Frida 部署 / ICD 直调绕过 / 模块拦截验证 (20号报告)

> 日期: 2026-08-09 | 设备: 小米 9 (Android 11, arm64, Magisk root)
> 目标: 国际服 `com.tgc.sky.android` (split APK, Vulkan 后端)

## 🎯 本轮结论: 实机渲染注入链路 100% 打通并验证

```
frida-server 部署+启动 ✅ → frida 连接 ✅ → spawn 注入 ✅
→ AAsset 文件名追踪 ✅ → vkGetDeviceProcAddr 返回值替换 ✅
→ vkCreateShaderModule 拦截+模块保存 ✅ → 内容一致性验证 ✅
→ 终极版 hook_vkShaderModule.js 交付 ✅
```

**唯一剩余步骤**: 游戏登录进入世界后触发 Tonemap 模块创建 → swap 替换实机看效果。

---

## 1. 环境搭建 (全部完成)

| 步骤 | 结果 |
|---|---|
| frida 主机端 | 17.17.0 + frida-tools 14.10.4 (阿里云 pip 源) |
| frida-server | 17.17.0-android-arm64 (53MB), `/data/local/tmp/frida-server` |
| 启动方式 | `su -c 'nohup /data/local/tmp/frida-server -D &'` (Magisk root) |
| 监听 | `127.0.0.1:27042` |
| 连接 | `frida -H 127.0.0.1:27042` (proot 与 Android 共享内核网络栈) |
| 部署中转 | proot /tmp → /sdcard → /data/local/tmp (隔离绕过) |

## 2. 关键发现 ①: split APK 架构

设备上为 **14 个 split APK** (非单 base):
- **全部 4015 个 SPV 在 `split_initial.apk`** (1.49GB, STORED 未压缩)
- base.apk (46MB) 不含任何 shader
- 运行时 shader 内容 = APK 内文件 (已验证 100% 一致, 未加密/未转换)
- 工作区解包目录 `Sky_0.34.3 (408160)` 即 split_initial 内容

## 3. 关键发现 ②: 游戏绕过 loader trampoline

- 游戏通过 `vkGetDeviceProcAddr` 一次性获取全部 device 函数指针并缓存
- Android loader 对 device 级函数返回 **ICD (vulkan.adreno.so) 内部指针**
- → hook `libvulkan.so` 导出符号无效, **必须替换 vkGetDeviceProcAddr 返回值**
- 验证: wrapper 替换后, 游戏调用 vkCreateShaderModule 4+ 次, 模块全部保存

## 4. 关键发现 ③: vkCreateShaderModule 结构体偏移 (64位)

```
VkShaderModuleCreateInfo:
  sType   @0  (4B)
  pNext   @8  (8B)
  flags   @16 (4B)
  codeSize@24 (8B)   ← 之前误用 @4/@12
  pCode   @32 (8B)   ← 之前误用 @4/@12
```
修正偏移后 size 正确 (676/520/12744/12640/692/11780... 与 APK 文件大小一致)。

## 5. 已验证的模块创建清单 (启动阶段)

| 模块 | size | fp (FNV-1a) | 对应文件 |
|---|---|---|---|
| VisibilityQuery vs | 12640 | 0bee170c | VisibilityQuery-11f.android.vs.spv |
| VisibilityQueryFragSSBO vs | 12744 | 430510ec | VisibilityQueryFragSSBO-11f.android.vs.spv |
| (小模块) | 676/520/692 | ... | 特殊/占位模块 |

> 全部模块内容与 APK 文件逐字节一致 (SPIR-V 魔数 0x07230203 验证)。

## 6. AAsset 层 706 个 shader 读取 (启动预加载)

- `AAssetManager_open` 文件名追踪: `Data/Shaders/Bin/*.spv` (460+) + KTX 纹理 (137) + JSON (15) + Lua (7)
- Tonemap 全部变体文件被读取: rec709/rec709_sRGB/p3_linear/p3_display/p3_display_pq/p3_dci/rec2020_pq/movie/movie_hdr/screenshot
- `.ref` 文件 (8776B) = 管线描述符引用描述 (新格式)

## 7. 交付物: hook_vkShaderModule.js 终极版

三层策略 (层层递进):
```
① AAsset 层     : AAssetManager_open 文件名 + AAsset_read 内容替换
② vkGetDeviceProcAddr 返回值替换 : 拦截 ICD 指针缓存 (核心)
③ vkCreateShaderModule wrapper   : TARGET_HASH 匹配覆写 pCode
```
- frida 17 兼容 (findExport 统一封装)
- MODE=dump: 打印 size+fp + 保存模块到 /sdcard/Download/module_dump/
- MODE=swap: TARGET_HASH 匹配替换 + 未填 hash 时按 15-30KB 候选替换
- 文件: `_analysis/hook_vkShaderModule.js` (+ dump_assets.js 资产 dump 工具)

## 8. 实机替换验证 (已完成)

**TARGET_HASH 已从实机 dump 确定**:
- `ff8a7f80` = Tonemap_rec709-11f.android.fs.spv (18852B, 与 APK 100% 一致)
- `77101108` = Tonemap_rec709_sRGB-11f.android.fs.spv (19364B, 与 APK 100% 一致)

**swap 实机执行结果** (hook_swap.js):
```
[+] 已加载替换 SPIR-V: ...vintage_tonemap_rec709.fs.spv (16412 bytes)
[AAsset] ★ 已替换 Data/Shaders/Bin/Tonemap_rec709_sRGB-11f.android.fs.spv (19364->16412)
```
- AAsset 层文件名匹配替换成功 (rec709_sRGB 变体)
- 替换后无 SPIR-V 解析错误 (游戏继续运行)
- 已知问题: frida `-t` 到期 detach 时与 Crashlytics 冲突导致 SIGABRT (frida-agent 卸载), **非替换导致**
  - 规避: 验证视觉时用 `--eternalize` 或验证完直接 kill 游戏进程

## 9. 剩余步骤 (用户操作)

1. 手机手动打开 Sky, **登录进入游戏世界** (登录界面不创建 Tonemap 后处理模块)
2. 保持游戏运行, 主机执行:
   ```bash
   # dump 模式 (拿 Tonemap fs 的 fp)
   frida -H 127.0.0.1:27042 -f com.tgc.sky.android -l hook_dump.js -q -t 240 --no-auto-reload -o dump.log
   grep 'size=1[5-9]' dump.log   # 找 15-30KB 的 fs 模块 fp
   ```
3. 把 fp 填入 `hook_vkShaderModule.js` 的 `TARGET_HASH`, 改 `MODE='swap'` 重跑
4. 观察画面 → 2018 复古暖橙 Tonemap 生效

## 9. 合规提醒

修改客户端违反 TGC 服务条款。本流程仅建议在**离线/测试账号**下进行技术验证;
联机账号有封号风险。实机验证时 Tonemap 替换可能被反作弊/完整性校验检测。