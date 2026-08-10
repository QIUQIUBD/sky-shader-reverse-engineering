/*
 * dump_assets.js — 保存游戏运行时读取的完整 .spv 字节 + 验证 shader 创建路径
 * 用途: 分析游戏对 shader 的运行时处理 (加密/转换?) + 确认 vkCreateShaderModule vs vkCreateShadersEXT
 */
'use strict';

const assetNames = new Map();
const saved = new Set();
const DUMP_DIR = '/sdcard/Download/asset_dump/';
const MODULE_DIR = '/sdcard/Download/module_dump/';

/* frida 17 兼容: 模块导出查找 (Module.getExportByName/findExportByName 均已移除) */
function findExport(moduleName, exportName) {
    try {
        const m = Process.findModuleByName(moduleName);
        return m ? m.getExportByName(exportName) : null;
    } catch (e) {
        return null;
    }
}

/* FNV-1a 32bit 指纹 (与 hook_vkShaderModule.js 一致) */
function sha256hex(buf) {
    let h = 0x811c9dc5;
    const dv = new Uint8Array(buf);
    for (let i = 0; i < dv.length; i++) {
        h ^= dv[i];
        h = (h * 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
}

function saveAsset(name, buf, n) {
    const base = name.split('/').pop();
    const key = base + '|' + n;
    if (saved.has(key)) return;
    saved.add(key);
    try {
        const f = new File(DUMP_DIR + base, 'wb');
        f.write(buf.readByteArray(n));
        f.close();
        console.log('[SAVE] ' + name + ' ' + n + ' bytes');
    } catch (e) {
        console.log('[SAVE-FAIL] ' + name + ' ' + e);
    }
}

setTimeout(() => {
    console.log('[+] asset dumper 启动');

    // 1. 文件名追踪
    try {
        const open = findExport('libandroid.so', 'AAssetManager_open');
        Interceptor.attach(open, {
            onEnter(args) { this.fname = args[1].isNull() ? '?' : args[1].readCString(); },
            onLeave(retval) { if (!retval.isNull() && this.fname) assetNames.set(retval.toString(), this.fname); }
        });
        console.log('[+] AAssetManager_open hooked');
    } catch (e) { console.log('[-] AAssetManager_open: ' + e); }

    // 2. 保存完整 shader 读取
    try {
        const read = findExport('libandroid.so', 'AAsset_read');
        Interceptor.attach(read, {
            onEnter(args) {
                this.asset = args[0];
                this.buf = args[1];
                this.n = args[2].toInt32();
            },
            onLeave(retval) {
                const n = retval.toInt32();
                if (n <= 0) return;
                const name = assetNames.get(this.asset.toString()) || '?';
                if (name.indexOf('.spv') >= 0 && n > 4000) {
                    saveAsset(name, this.buf, n);
                }
            }
        });
        console.log('[+] AAsset_read hooked');
    } catch (e) { console.log('[-] AAsset_read: ' + e); }

    // 3. 终极方案: hook vkGetDeviceProcAddr 返回值, 拦截 vkCreateShaderModule 指针
    try {
        const gdpa = findExport('libvulkan.so', 'vkGetDeviceProcAddr');
        if (!gdpa) {
            console.log('[-] vkGetDeviceProcAddr not found');
        } else {
            // 先解析 ICD 或 loader 的真实 vkCreateShaderModule (作为 wrapper 内部调用)
            let realCSM = findExport('vulkan.adreno.so', 'vkCreateShaderModule')
                || findExport('libvulkan.so', 'vkCreateShaderModule');
            if (!realCSM) { console.log('[-] real vkCreateShaderModule not found'); }
            else {
                const wrapper = new NativeCallback(function (device, pCreateInfo, pAllocator, pShaderModule) {
                    try {
                        // VkShaderModuleCreateInfo (64位): sType@0, pNext@8, flags@16, codeSize@24, pCode@32
                        const codeSize = pCreateInfo.add(24).readU64().toNumber();
                        const pCode = pCreateInfo.add(32).readPointer();
                        if (codeSize < 100) { console.log('[WRAPPER-CSM] size=' + codeSize + ' (忽略)'); }
                        else {
                            const fp = sha256hex(pCode.readByteArray(Math.min(codeSize, 65536)));
                            console.log('[WRAPPER-CSM] size=' + codeSize + ' fp=' + fp);
                            try {
                                const path = MODULE_DIR + 'module_' + fp + '_' + codeSize + '.spv';
                                const f = new File(path, 'wb');
                                f.write(pCode.readByteArray(codeSize));
                                f.close();
                                console.log('[MODULE-SAVED] ' + path);
                            } catch (e2) { console.log('[MODULE-FAIL] ' + e2); }
                        }
                    } catch (e3) { console.log('[WRAPPER-ERR] ' + e3); }
                    return realCSM(device, pCreateInfo, pAllocator, pShaderModule);
                }, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);

                Interceptor.attach(gdpa, {
                    onEnter(args) {
                        this.reqName = args[1].isNull() ? '?' : args[1].readCString();
                    },
                    onLeave(retval) {
                        if (this.reqName === 'vkCreateShaderModule') {
                            console.log('[GDPA] 替换 vkCreateShaderModule 指针 -> wrapper');
                            retval.replace(wrapper);
                        } else if (this.reqName.indexOf('Shader') >= 0 || this.reqName.indexOf('Pipeline') >= 0) {
                            console.log('[VK-PROC] ' + this.reqName);
                        }
                    }
                });
                console.log('[+] vkGetDeviceProcAddr hooked (wrapper 就绪)');
            }
        }
    } catch (e) { console.log('[-] gdpa hook: ' + e); }

    console.log('[+] 全部 hook 就绪');
}, 0);