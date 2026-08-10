/*
 * diag_render_path.js — 渲染路径全面诊断
 * 目标: 找出 Tonemap 实际渲染走的路径
 * 1. vkCreateShaderModule: 红色替换 + codeSize覆写 (保留, 验证)
 * 2. module 表: handle -> (fp, size, replaced)
 * 3. vkCreateGraphicsPipelines: dump 每个 pipeline 的 fragment module fp
 * 4. vkGetShaderModuleCreateInfoIdentifierEXT / vkGetShaderModuleIdentifierEXT: identifier 机制
 * 5. GLES glShaderSource: 是否走 GLES shader 编译
 */
'use strict';

const TARGET_HASH = '77101108'; // Tonemap_rec709_sRGB fs
const SPV_ASSET_PATH = '/data/data/com.tgc.sky.android/files/red_test.spv';

let replacementSpv = null;
let replacementSize = 0;
const moduleTable = {}; // handle -> {fp, size, replaced}

function findExport(moduleName, exportName) {
    try {
        const m = Process.findModuleByName(moduleName);
        return m ? m.getExportByName(exportName) : null;
    } catch (e) {
        return null;
    }
}

function fnv1a(buf) {
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
    replacementSpv = f.readBytes(200000);
    replacementSize = replacementSpv.byteLength;
    f.close();
    console.log('[+] 替换 SPIR-V: ' + replacementSize + 'B');
}

function hookGles() {
    const mod = Process.findModuleByName('libGLESv2.so') || Process.findModuleByName('libGLESv3.so');
    if (!mod) { console.log('[-] GLES 模块未找到'); return; }
    const glShaderSource = mod.getExportByName('glShaderSource');
    if (!glShaderSource) { console.log('[-] glShaderSource 未找到'); return; }
    Interceptor.attach(glShaderSource, {
        onEnter(args) {
            try {
                const count = args[1].toInt32();
                const stringsPtr = args[2];
                let src = '';
                if (count > 0) {
                    src = stringsPtr.readPointer().readCString() || '';
                }
                const low = src.toLowerCase();
                if (low.includes('tonemap') || low.includes('tone map') || low.includes('reinhard') || low.includes('aces')) {
                    console.log('[GLES] glShaderSource #' + args[0].toInt32() + ' len=' + src.length + ' head=' + src.replace(/\n/g, ' ').substring(0, 150));
                }
            } catch (e) {
                console.log('[GLES-ERR] ' + e);
            }
        }
    });
    console.log('[+] glShaderSource hooked (libGLESv2/v3)');
}

function hookVulkanLayer() {
    let realCSMPtr = findExport('vulkan.adreno.so', 'vkCreateShaderModule')
        || findExport('libvulkan.so', 'vkCreateShaderModule');
    if (!realCSMPtr) { console.log('[-] real vkCreateShaderModule 未找到'); return; }
    const realCSM = new NativeFunction(realCSMPtr, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);
    console.log('[+] real vkCreateShaderModule @ ' + realCSMPtr);

    // ---- vkCreateGraphicsPipelines wrapper (记录 fragment module) ----
    const pipeWrapper = new NativeCallback(function (device, cache, count, pCreateInfos, pAllocator, pPipelines) {
        try {
            const n = count.toInt32();
            for (let i = 0; i < n; i++) {
                const ci = pCreateInfos.add(i * 136);
                const stageCount = ci.add(20).readU32();
                const pStages = ci.add(24).readPointer();
                for (let s = 0; s < stageCount; s++) {
                    const st = pStages.add(s * 48);
                    const stage = st.add(20).readU32();
                    const modHandle = st.add(24).readPointer();
                    if (stage === 0x10) { // VK_SHADER_STAGE_FRAGMENT_BIT
                        const info = moduleTable[modHandle.toString()];
                        if (info) {
                            console.log('[PIPE] fragment module=' + modHandle + ' fp=' + info.fp + ' size=' + info.size + (info.replaced ? ' ★替换过' : ''));
                        } else {
                            console.log('[PIPE] fragment module=' + modHandle + ' (未记录)');
                        }
                    }
                }
            }
        } catch (e) {
            console.log('[PIPE-ERR] ' + e);
        }
        return realCreateGraphicsPipelines(device, cache, count, pCreateInfos, pAllocator, pPipelines);
    }, 'uint32', ['pointer', 'pointer', 'uint32', 'pointer', 'pointer', 'pointer']);
    const realCreateGraphicsPipelinesPtr = findExport('vulkan.adreno.so', 'vkCreateGraphicsPipelines')
        || findExport('libvulkan.so', 'vkCreateGraphicsPipelines');
    const realCreateGraphicsPipelines = realCreateGraphicsPipelinesPtr
        ? new NativeFunction(realCreateGraphicsPipelinesPtr, 'uint32', ['pointer', 'pointer', 'uint32', 'pointer', 'pointer', 'pointer'])
        : null;
    if (!realCreateGraphicsPipelines) console.log('[-] real vkCreateGraphicsPipelines 未找到');

    // ---- vkCreateShaderModule wrapper ----
    const wrapper = new NativeCallback(function (device, pCreateInfo, pAllocator, pShaderModule) {
        let replaced = false;
        try {
            const codeSize = pCreateInfo.add(24).readU64().toNumber();
            if (codeSize > 15000 && codeSize < 30000) {
                const pCode = pCreateInfo.add(32).readPointer();
                const fp = fnv1a(pCode.readByteArray(Math.min(codeSize, 65536)));
                if (fp === TARGET_HASH && replacementSpv) {
                    pCode.writeByteArray(replacementSpv);
                    pCreateInfo.add(24).writeU64(replacementSize);
                    replaced = true;
                    console.log('[VK] ★★ RED-TEST 替换 (' + codeSize + '->' + replacementSize + 'B, codeSize覆写)');
                }
            }
        } catch (e) {
            console.log('[WRAPPER-ERR] ' + e);
        }
        const result = realCSM(device, pCreateInfo, pAllocator, pShaderModule);
        try {
            const handle = pShaderModule.readPointer().toString();
            moduleTable[handle] = { fp: replaced ? TARGET_HASH : '?', size: replaced ? replacementSize : 0, replaced: replaced };
            if (replaced) console.log('[MODULE] handle=' + handle + ' fp=' + TARGET_HASH + ' size=' + replacementSize + ' ★');
        } catch (e) { console.log('[MODULE-ERR] ' + e); }
        return result;
    }, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);

    // ---- GDPA: 替换 vkCreateShaderModule + vkCreateGraphicsPipelines + identifier ----
    const gdpa = findExport('libvulkan.so', 'vkGetDeviceProcAddr');
    if (gdpa) {
        Interceptor.attach(gdpa, {
            onEnter(args) { this.reqName = args[1].isNull() ? '?' : args[1].readCString(); },
            onLeave(retval) {
                if (this.reqName === 'vkCreateShaderModule') {
                    retval.replace(wrapper);
                } else if (this.reqName === 'vkCreateGraphicsPipelines' && realCreateGraphicsPipelines) {
                    retval.replace(pipeWrapper);
                } else if (this.reqName === 'vkGetShaderModuleCreateInfoIdentifierEXT') {
                    const fn = new NativeFunction(retval, 'void', ['pointer', 'pointer', 'pointer']);
                    Interceptor.replace(retval, new NativeCallback(function (dev, pCreateInfo, pIdentifier) {
                        try {
                            const codeSize = pCreateInfo.add(24).readU64().toNumber();
                            const pCode = pCreateInfo.add(32).readPointer();
                            const fp = fnv1a(pCode.readByteArray(Math.min(codeSize, 65536)));
                            console.log('[IDENT-CREATE] codeSize=' + codeSize + ' fp=' + fp);
                        } catch (e) { console.log('[IDENT-CREATE-ERR] ' + e); }
                        fn(dev, pCreateInfo, pIdentifier);
                    }, 'void', ['pointer', 'pointer', 'pointer']));
                    console.log('[+] vkGetShaderModuleCreateInfoIdentifierEXT hooked');
                } else if (this.reqName === 'vkGetShaderModuleIdentifierEXT') {
                    const fn = new NativeFunction(retval, 'void', ['pointer', 'pointer', 'pointer']);
                    Interceptor.replace(retval, new NativeCallback(function (dev, mod, pIdentifier) {
                        console.log('[IDENT-MODULE] handle=' + mod);
                        fn(dev, mod, pIdentifier);
                    }, 'void', ['pointer', 'pointer', 'pointer']));
                    console.log('[+] vkGetShaderModuleIdentifierEXT hooked');
                }
            }
        });
        console.log('[+] vkGetDeviceProcAddr hooked');
    }

    try {
        Interceptor.attach(realCSMPtr, {
            onEnter(args) {
                const pCreateInfo = args[1];
                const codeSize = pCreateInfo.add(24).readU64().toNumber();
                if (codeSize > 15000 && codeSize < 30000) {
                    const pCode = pCreateInfo.add(32).readPointer();
                    const fp = fnv1a(pCode.readByteArray(Math.min(codeSize, 65536)));
                    if (fp === TARGET_HASH && replacementSpv) {
                        pCode.writeByteArray(replacementSpv);
                        pCreateInfo.add(24).writeU64(replacementSize);
                        console.log('[VK-DIRECT] ★★ RED-TEST 替换 (' + codeSize + '->' + replacementSize + 'B, codeSize覆写)');
                    }
                }
            }
        });
        console.log('[+] vkCreateShaderModule direct hooked');
    } catch (e) {
        console.log('[-] direct hook: ' + e);
    }
}

setTimeout(() => {
    console.log('[+] Sky 渲染路径诊断启动');
    loadReplacement();
    hookVulkanLayer();
    hookGles();
    console.log('[+] 就绪 (TARGET=' + TARGET_HASH + ')');
}, 0);
