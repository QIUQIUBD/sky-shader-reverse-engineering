/*
 * ============================================================================
 * hook_vkShaderModule.js — Sky 国际服 0.34.x 渲染注入框架 (Frida 终极版)
 * ============================================================================
 * 目标: 安卓 arm64, Vulkan 后端 (Adreno ICD: vulkan.adreno.so)
 * 兼容: frida 17 (Module.findExportByName/getExportByName 已移除)
 *
 * 三层策略 (层层递进):
 *   ① AAsset 层: AAssetManager_open 文件名追踪 + AAsset_read 内容替换
 *   ② vkGetDeviceProcAddr 返回值替换: 游戏缓存 ICD 函数指针绕过 loader,
 *      此层替换返回指针为 wrapper, 无论游戏如何缓存必经拦截 (核心)
 *   ③ vkCreateShaderModule wrapper: 匹配 TARGET_HASH 时覆写 pCode
 *
 * 用法:
 *   frida -H 127.0.0.1:27042 -f com.tgc.sky.android -l hook_vkShaderModule.js -q -t 240 --no-auto-reload -o log.txt
 *
 * 模式:
 *   MODE=dump   打印 vkCreateShaderModule 调用 (size+fp) + 保存模块到 module_dump/
 *   MODE=swap   匹配 TARGET_HASH 时替换为 vintage_tonemap_rec709.fs.spv
 *
 * 替换资产: vintage_tonemap_rec709.fs.spv (2026 骨架 + 2018 内胆, 接口兼容已验证)
 * ============================================================================
 */
'use strict';

const MODE = 'swap'; // 'dump' | 'swap'
const TARGET_HASH = ''; // dump 模式输出后填写 (Tonemap_rec709 fs 模块的 FNV fp)
const SPV_ASSET_PATH = '/sdcard/Download/vintage_tonemap_rec709.fs.spv';
const MODULE_DIR = '/sdcard/Download/module_dump/';

// 缓存替换用的 SPIR-V
let replacementSpv = null;
let replacementSize = 0;

/* frida 17 兼容: 模块导出查找 */
function findExport(moduleName, exportName) {
    try {
        const m = Process.findModuleByName(moduleName);
        return m ? m.getExportByName(exportName) : null;
    } catch (e) {
        return null;
    }
}

/* FNV-1a 32bit 指纹 */
function sha256hex(buf) {
    let h = 0x811c9dc5;
    const dv = new Uint8Array(buf);
    for (let i = 0; i < dv.length; i++) {
        h ^= dv[i];
        h = (h * 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
}

function loadReplacement() {
    const f = new File(SPV_ASSET_PATH, 'r');
    replacementSpv = f.readBytes(200000); // 一次性读入 (SPV 仅 16KB)
    replacementSize = replacementSpv.byteLength; // frida17: f.size 不可用, 用 byteLength
    f.close();
    console.log(`[+] 已加载替换 SPIR-V: ${SPV_ASSET_PATH} (${replacementSize} bytes)`);
}

function saveModule(pCode, codeSize, fp) {
    try {
        const path = MODULE_DIR + 'module_' + fp + '_' + codeSize + '.spv';
        const f = new File(path, 'wb');
        f.write(pCode.readByteArray(codeSize));
        f.close();
        console.log('[MODULE-SAVED] ' + path);
    } catch (e) {
        console.log('[MODULE-FAIL] ' + e);
    }
}

/* ============================================================================
 * 策略 ①: AAsset 层 — 文件名追踪 + 内容替换
 * ========================================================================== */
function hookAssetLayer() {
    const libandroid = Process.findModuleByName('libandroid.so');
    if (!libandroid) { console.log('[-] libandroid.so 未找到, 跳过 AAsset 层'); return; }

    const assetNames = new Map();
    const open = findExport('libandroid.so', 'AAssetManager_open');
    if (open) {
        Interceptor.attach(open, {
            onEnter(args) { this.fname = args[1].isNull() ? '?' : args[1].readCString(); },
            onLeave(retval) { if (!retval.isNull() && this.fname) assetNames.set(retval.toString(), this.fname); }
        });
        console.log('[+] AAssetManager_open hooked');
    }

    const read = findExport('libandroid.so', 'AAsset_read');
    if (read) {
        Interceptor.attach(read, {
            onEnter(args) {
                this.asset = args[0];
                this.buf = args[1];
                this.count = args[2].toInt32();
            },
            onLeave(retval) {
                const n = retval.toInt32();
                if (n <= 0) return;
                const name = assetNames.get(this.asset.toString()) || '?';
                const data = this.buf.readByteArray(Math.min(n, 4096));
                const fp = sha256hex(data);
                if (MODE === 'dump') {
                    if (n >= 5000 && n <= 30000) console.log(`[AAsset] read ${n} bytes fp=${fp} name=${name}`);
                } else if (MODE === 'swap') {
                    // AAsset 层: 文件名匹配 Tonemap_rec709 fs (最终替换点)
                    if (name.indexOf('Tonemap_rec709') >= 0 && name.indexOf('.fs.spv') >= 0) {
                        if (replacementSpv) {
                            this.buf.writeByteArray(replacementSpv);
                            console.log(`[AAsset] ★ 已替换 ${name} (${n}->${replacementSize})`);
                            retval.replace(ptr(replacementSize));
                        }
                    }
                }
            }
        });
        console.log('[+] AAsset_read hooked');
    }
}

/* ============================================================================
 * 策略 ②+③: vkGetDeviceProcAddr 返回值替换 + vkCreateShaderModule wrapper
 * 游戏通过 vkGetDeviceProcAddr 获取 ICD 函数指针并缓存 (绕过 loader trampoline),
 * 必须替换返回值才能拦截。
 * ========================================================================== */
function hookVulkanLayer() {
    // 解析真实 vkCreateShaderModule (ICD 优先, 其次 loader)
    let realCSMPtr = findExport('vulkan.adreno.so', 'vkCreateShaderModule')
        || findExport('libvulkan.so', 'vkCreateShaderModule');
    if (!realCSMPtr) { console.log('[-] real vkCreateShaderModule 未找到'); return; }
    const realCSM = new NativeFunction(realCSMPtr, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);
    console.log('[+] real vkCreateShaderModule @ ' + realCSMPtr);

    const wrapper = new NativeCallback(function (device, pCreateInfo, pAllocator, pShaderModule) {
        try {
            // VkShaderModuleCreateInfo (64位): sType@0, pNext@8, flags@16, codeSize@24, pCode@32
            const codeSize = pCreateInfo.add(24).readU64().toNumber();
            const pCode = pCreateInfo.add(32).readPointer();
            if (codeSize < 100) return realCSM(device, pCreateInfo, pAllocator, pShaderModule);

            const fp = sha256hex(pCode.readByteArray(Math.min(codeSize, 65536)));
            if (MODE === 'dump') {
                console.log(`[VK] CreateShaderModule size=${codeSize} fp=${fp}`);
                if (codeSize >= 5000) saveModule(pCode, codeSize, fp);
            } else if (MODE === 'swap') {
                if (TARGET_HASH && fp === TARGET_HASH && replacementSpv) {
                    pCode.writeByteArray(replacementSpv);
                    console.log(`[VK] ★ 已替换 Tonemap 模块 (size=${codeSize}->${replacementSize} fp=${fp})`);
                } else if (!TARGET_HASH && codeSize > 15000 && codeSize < 30000) {
                    // 未填 TARGET_HASH 时: 按大小候选替换 (fs 模块 15-30KB)
                    pCode.writeByteArray(replacementSpv);
                    console.log(`[VK] ★ 候选替换 (size=${codeSize}->${replacementSize} fp=${fp})`);
                } else {
                    console.log(`[VK] 未匹配 size=${codeSize} fp=${fp}`);
                }
            }
        } catch (e) {
            console.log('[WRAPPER-ERR] ' + e);
        }
        return realCSM(device, pCreateInfo, pAllocator, pShaderModule);
    }, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);

    const gdpa = findExport('libvulkan.so', 'vkGetDeviceProcAddr');
    if (gdpa) {
        Interceptor.attach(gdpa, {
            onEnter(args) {
                this.reqName = args[1].isNull() ? '?' : args[1].readCString();
            },
            onLeave(retval) {
                if (this.reqName === 'vkCreateShaderModule') {
                    console.log('[GDPA] 替换 vkCreateShaderModule 指针 -> wrapper');
                    retval.replace(wrapper);
                }
            }
        });
        console.log('[+] vkGetDeviceProcAddr hooked');
    }

    // 保险: 直接 hook ICD/loader 导出 (若游戏未走 vkGetDeviceProcAddr)
    try {
        Interceptor.attach(realCSMPtr, {
            onEnter(args) {
                const pCreateInfo = args[1];
                const codeSize = pCreateInfo.add(24).readU64().toNumber();
                const pCode = pCreateInfo.add(32).readPointer();
                const fp = sha256hex(pCode.readByteArray(Math.min(codeSize, 65536)));
                if (MODE === 'dump') {
                    console.log(`[VK-DIRECT] size=${codeSize} fp=${fp}`);
                    if (codeSize >= 5000) saveModule(pCode, codeSize, fp);
                }
            }
        });
        console.log('[+] vkCreateShaderModule direct hooked');
    } catch (e) {
        console.log('[-] direct hook: ' + e);
    }
}

/* ============================================================================
 * 入口
 * ========================================================================== */
setTimeout(() => {
    console.log('[+] Sky Vulkan 注入框架 (终极版) 启动');
    if (MODE === 'swap') loadReplacement();
    hookAssetLayer();
    hookVulkanLayer();
    console.log('[+] 全部 hook 就绪, 等待游戏创建 shader 模块...');
}, 0);