/*
 * diag2.js — 渲染路径诊断 v2 (修复 PIPE hook)
 * 核心问题: 红色替换命中但画面不变, 找出渲染真正使用的 shader 来源
 * 1. 记录所有 vkCreateShaderModule (fp+size+handle)
 * 2. hook vkCreateGraphicsPipelines + vkCreateComputePipelines: 打印每个 pipeline 的 shader module fp
 * 3. glShaderSource 总调用计数 (确认 GLES 是否用于 shader 编译)
 */
'use strict';

const TARGET_HASH = '77101108';
const SPV_ASSET_PATH = '/data/data/com.tgc.sky.android/files/red_test.spv';

let replacementSpv = null;
let replacementSize = 0;
let glesShaderCalls = 0;
const moduleTable = {};

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
            glesShaderCalls++;
            try {
                const count = args[1].toInt32();
                let src = '';
                if (count > 0) src = args[2].readPointer().readCString() || '';
                const low = src.toLowerCase();
                if (low.includes('tonemap') || low.includes('tone map') || low.includes('reinhard')) {
                    console.log('[GLES] #' + glesShaderCalls + ' tonemap相关 len=' + src.length + ' head=' + src.replace(/\n/g, ' ').substring(0, 120));
                }
            } catch (e) { console.log('[GLES-ERR] ' + e); }
        }
    });
    setInterval(() => {
        if (glesShaderCalls > 0) console.log('[GLES-STAT] glShaderSource 总调用=' + glesShaderCalls);
    }, 10000);
    console.log('[+] glShaderSource hooked');
}

function hookPipelines() {
    // ---- vkCreateGraphicsPipelines ----
    const cgpPtr = findExport('vulkan.adreno.so', 'vkCreateGraphicsPipelines') || findExport('libvulkan.so', 'vkCreateGraphicsPipelines');
    if (cgpPtr) {
        const realCGP = new NativeFunction(cgpPtr, 'uint32', ['pointer', 'pointer', 'uint32', 'pointer', 'pointer', 'pointer']);
        Interceptor.attach(cgpPtr, {
            onEnter(args) {
                try {
                    const n = args[2].toInt32();
                    const pCreateInfos = args[3];
                    for (let i = 0; i < n; i++) {
                        const ci = pCreateInfos.add(i * 136);
                        const stageCount = ci.add(20).readU32();
                        const pStages = ci.add(24).readPointer();
                        let stages = [];
                        for (let s = 0; s < stageCount; s++) {
                            const st = pStages.add(s * 48);
                            const stage = st.add(20).readU32();
                            const modHandle = st.add(24).readPointer();
                            const info = moduleTable[modHandle.toString()];
                            stages.push(stage === 0x10 ? 'FS' : (stage === 0x8 ? 'VS' : (stage === 0x20 ? 'CS' : 'S' + stage)) +
                                ':' + modHandle + (info ? '(' + info.fp + ',' + info.size + (info.replaced ? '★' : '') + ')' : '(未记录)'));
                        }
                        console.log('[PIPE-G] #' + i + ' stages=' + stages.join(' '));
                    }
                } catch (e) { console.log('[PIPE-G-ERR] ' + e); }
            }
        });
        console.log('[+] vkCreateGraphicsPipelines hooked @ ' + cgpPtr);
    } else {
        console.log('[-] vkCreateGraphicsPipelines 导出未找到');
    }

    // ---- vkCreateComputePipelines ----
    const ccpPtr = findExport('vulkan.adreno.so', 'vkCreateComputePipelines') || findExport('libvulkan.so', 'vkCreateComputePipelines');
    if (ccpPtr) {
        Interceptor.attach(ccpPtr, {
            onEnter(args) {
                try {
                    const n = args[2].toInt32();
                    const pInfos = args[3];
                    for (let i = 0; i < n; i++) {
                        const ci = pInfos.add(i * 64);
                        const modHandle = ci.add(24).readPointer();
                        const info = moduleTable[modHandle.toString()];
                        console.log('[PIPE-C] #' + i + ' CS:' + modHandle + (info ? '(' + info.fp + ',' + info.size + (info.replaced ? '★' : '') + ')' : '(未记录)'));
                    }
                } catch (e) { console.log('[PIPE-C-ERR] ' + e); }
            }
        });
        console.log('[+] vkCreateComputePipelines hooked @ ' + ccpPtr);
    }
}

function hookVulkanLayer() {
    let realCSMPtr = findExport('vulkan.adreno.so', 'vkCreateShaderModule')
        || findExport('libvulkan.so', 'vkCreateShaderModule');
    if (!realCSMPtr) { console.log('[-] real vkCreateShaderModule 未找到'); return; }
    const realCSM = new NativeFunction(realCSMPtr, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);
    console.log('[+] real vkCreateShaderModule @ ' + realCSMPtr);

    const wrapper = new NativeCallback(function (device, pCreateInfo, pAllocator, pShaderModule) {
        let replaced = false;
        let codeSize = 0, fp = '';
        try {
            codeSize = pCreateInfo.add(24).readU64().toNumber();
            if (codeSize > 100 && codeSize < 200000) {
                const pCode = pCreateInfo.add(32).readPointer();
                fp = fnv1a(pCode.readByteArray(Math.min(codeSize, 65536)));
                if (fp === TARGET_HASH && replacementSpv) {
                    pCode.writeByteArray(replacementSpv);
                    pCreateInfo.add(24).writeU64(replacementSize);
                    replaced = true;
                    console.log('[VK] ★★ RED-TEST 替换 (' + codeSize + '->' + replacementSize + 'B, codeSize覆写)');
                }
            }
        } catch (e) { console.log('[WRAPPER-ERR] ' + e); }
        const result = realCSM(device, pCreateInfo, pAllocator, pShaderModule);
        try {
            const handle = pShaderModule.readPointer().toString();
            moduleTable[handle] = { fp: replaced ? TARGET_HASH : fp, size: replaced ? replacementSize : codeSize, replaced: replaced };
            console.log('[MODULE] ' + handle + ' fp=' + (replaced ? TARGET_HASH : fp) + ' size=' + (replaced ? replacementSize : codeSize) + (replaced ? ' ★' : ''));
        } catch (e) { console.log('[MODULE-ERR] ' + e); }
        return result;
    }, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);

    const gdpa = findExport('libvulkan.so', 'vkGetDeviceProcAddr');
    if (gdpa) {
        Interceptor.attach(gdpa, {
            onEnter(args) { this.reqName = args[1].isNull() ? '?' : args[1].readCString(); },
            onLeave(retval) {
                if (this.reqName === 'vkCreateShaderModule') {
                    retval.replace(wrapper);
                }
            }
        });
        console.log('[+] vkGetDeviceProcAddr hooked');
    }
}

setTimeout(() => {
    console.log('[+] Sky 渲染路径诊断 v2 启动');
    loadReplacement();
    hookVulkanLayer();
    hookPipelines();
    hookGles();
    console.log('[+] 就绪');
}, 0);