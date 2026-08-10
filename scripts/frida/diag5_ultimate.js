/*
 * diag5.js — 终极 spawn 诊断 (完整 GDPA 捕获)
 * 1. GDPA 捕获所有 device 函数真实地址并 hook
 * 2. vkCreateShaderModule: 红色替换 + module 表 (handle->fp,size,replaced)
 * 3. vkCreateGraphicsPipelines/2KHR: pipeline 使用的 shader module
 * 4. vkCmdBindPipeline: 每帧绑定的 pipeline (对照)
 * 5. vkQueuePresentKHR: 帧计数
 */
'use strict';

const TARGET_HASH = '77101108';
const SPV_ASSET_PATH = '/data/data/com.tgc.sky.android/files/red_test.spv';

let replacementSpv = null;
let replacementSize = 0;
let presentCount = 0;
const moduleTable = {};
const hooked = {};

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

function hookReal(name, addr) {
    if (!addr || addr.isNull()) return;
    const key = addr.toString();
    if (hooked[key]) return;
    hooked[key] = true;
    try {
        Interceptor.attach(addr, {
            onEnter(args) {
                if (name === 'vkCreateGraphicsPipelines') {
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
                                stages.push((stage === 0x10 ? 'FS' : stage === 0x8 ? 'VS' : stage === 0x20 ? 'CS' : 'S' + stage) +
                                    ':' + modHandle + (info ? '(' + info.fp + ',' + info.size + (info.replaced ? '★' : '') + ')' : '(未记录)'));
                            }
                            console.log('[PIPE-G] #' + i + ' stages=' + stages.join(' '));
                        }
                    } catch (e) { console.log('[PIPE-G-ERR] ' + e); }
                } else if (name === 'vkCreateGraphicsPipelines2KHR') {
                    try {
                        const n = args[2].toInt32();
                        const pInfos = args[3];
                        for (let i = 0; i < n; i++) {
                            // VkGraphicsPipelineCreateInfo2KHR: 布局不同, 打印 pStages 里 fragment module
                            const ci = pInfos.add(i * 144);
                            const stageCount = ci.add(20).readU32();
                            const pStages = ci.add(24).readPointer();
                            let stages = [];
                            for (let s = 0; s < stageCount; s++) {
                                const st = pStages.add(s * 48);
                                const stage = st.add(20).readU32();
                                const modHandle = st.add(24).readPointer();
                                const info = moduleTable[modHandle.toString()];
                                stages.push((stage === 0x10 ? 'FS' : stage === 0x8 ? 'VS' : 'S' + stage) + ':' + modHandle + (info ? '(' + info.fp + ')' : '(未记录)'));
                            }
                            console.log('[PIPE-2KHR] #' + i + ' stages=' + stages.join(' '));
                        }
                    } catch (e) { console.log('[PIPE-2KHR-ERR] ' + e); }
                } else if (name === 'vkCreateShadersEXT') {
                    try {
                        const n = args[1].toInt32();
                        const pInfos = args[2];
                        for (let i = 0; i < n; i++) {
                            const si = pInfos.add(i * 32);
                            const stage = si.add(4).readU32();
                            const codeSize = si.add(16).readU64().toNumber();
                            const pCode = si.add(24).readPointer();
                            let fp = '';
                            try { fp = fnv1a(pCode.readByteArray(Math.min(codeSize, 65536))); } catch (e) {}
                            console.log('[SHADER-OBJ] #' + i + ' stage=' + stage + ' size=' + codeSize + ' fp=' + fp);
                        }
                    } catch (e) { console.log('[SHADER-OBJ-ERR] ' + e); }
                } else if (name === 'vkCmdBindPipeline') {
                    const bindPoint = args[1].toInt32();
                    const pipe = args[2];
                    console.log('[BIND] point=' + bindPoint + ' pipeline=' + pipe);
                } else if (name === 'vkQueuePresentKHR') {
                    presentCount++;
                    if (presentCount % 30 === 1) console.log('[VK] present #' + presentCount);
                } else if (name === 'vkQueueSubmit') {
                    console.log('[VK] vkQueueSubmit');
                }
            }
        });
        console.log('[+] hooked ' + name + ' @ ' + addr);
    } catch (e) {
        console.log('[-] hook ' + name + ' fail: ' + e);
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
            if (fp === TARGET_HASH || replaced) console.log('[MODULE] ' + handle + ' fp=' + (replaced ? TARGET_HASH : fp) + ' size=' + (replaced ? replacementSize : codeSize) + (replaced ? ' ★' : ''));
        } catch (e) { console.log('[MODULE-ERR] ' + e); }
        return result;
    }, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);

    const gdpa = findExport('libvulkan.so', 'vkGetDeviceProcAddr');
    if (gdpa) {
        Interceptor.attach(gdpa, {
            onEnter(args) { this.reqName = args[1].isNull() ? '?' : args[1].readCString(); },
            onLeave(retval) {
                const n = this.reqName;
                if (n === 'vkCreateShaderModule') {
                    retval.replace(wrapper);
                    return;
                }
                const interesting = n.indexOf('vkCreateGraphicsPipelines') === 0 || n.indexOf('vkCreateComputePipelines') === 0 ||
                    n === 'vkQueuePresentKHR' || n === 'vkQueueSubmit' || n === 'vkCmdBindPipeline' ||
                    n === 'vkCmdDraw' || n === 'vkCmdDrawIndexed' || n === 'vkCreateShadersEXT' ||
                    n === 'vkCmdDrawIndirect' || n === 'vkCmdDrawIndexedIndirect';
                if (interesting) {
                    console.log('[GDPA] ' + n + ' -> ' + retval);
                    hookReal(n, retval);
                }
            }
        });
        console.log('[+] vkGetDeviceProcAddr hooked');
    }
}

setTimeout(() => {
    console.log('[+] Sky 终极诊断启动');
    loadReplacement();
    hookVulkanLayer();
    console.log('[+] 就绪 (TARGET=' + TARGET_HASH + ')');
}, 0);