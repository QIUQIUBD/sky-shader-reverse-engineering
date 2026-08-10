/*
 * diag3.js — 渲染 API 终极定位
 * 目标: 确定游戏实际渲染用的 API (GLES vs Vulkan) 和 shader 加载路径
 * 1. eglSwapBuffers: GLES 帧提交
 * 2. vkQueuePresentKHR / vkQueueSubmit: Vulkan 帧提交
 * 3. glShaderBinary / glShaderSource: GLES shader 加载
 * 4. GDPA 返回指针 vs findExport 对比
 * 5. 保留红色替换 (TARGET=77101108)
 */
'use strict';

const TARGET_HASH = '77101108';
const SPV_ASSET_PATH = '/data/data/com.tgc.sky.android/files/red_test.spv';

let replacementSpv = null;
let replacementSize = 0;

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

// ---- EGL 帧提交 ----
function hookEgl() {
    const egl = Process.findModuleByName('libEGL.so') || Process.findModuleByName('libEGL_adreno.so');
    if (!egl) { console.log('[-] EGL 模块未找到'); return; }
    const swap = egl.getExportByName('eglSwapBuffers');
    if (swap) {
        Interceptor.attach(swap, { onEnter() { console.log('[EGL] eglSwapBuffers (GLES帧提交)'); } });
        console.log('[+] eglSwapBuffers hooked @ ' + swap);
    } else {
        console.log('[-] eglSwapBuffers 未找到');
    }
}

// ---- GLES shader 加载 ----
function hookGlesShaders() {
    const gles = Process.findModuleByName('libGLESv3.so') || Process.findModuleByName('libGLESv2.so') || Process.findModuleByName('libGLESv2_adreno.so');
    if (!gles) { console.log('[-] GLES 模块未找到'); return; }
    console.log('[+] GLES 模块: ' + gles.name);
    const gsb = gles.getExportByName('glShaderBinary');
    if (gsb) {
        Interceptor.attach(gsb, {
            onEnter(args) {
                // glShaderBinary(GLsizei count, const GLuint* shaders, GLenum binaryformat, const void* binary, GLsizei length)
                const count = args[0].toInt32();
                const fmt = args[2].toInt32();
                const len = args[4].toInt32();
                console.log('[GLES] glShaderBinary count=' + count + ' format=0x' + fmt.toString(16) + ' len=' + len);
            }
        });
        console.log('[+] glShaderBinary hooked');
    }
    const gss = gles.getExportByName('glShaderSource');
    if (gss) {
        Interceptor.attach(gss, {
            onEnter(args) {
                try {
                    const count = args[1].toInt32();
                    let src = '';
                    if (count > 0) src = args[2].readPointer().readCString() || '';
                    console.log('[GLES] glShaderSource len=' + src.length + ' head=' + src.replace(/\n/g, ' ').substring(0, 100));
                } catch (e) { console.log('[GLES-SRC-ERR] ' + e); }
            }
        });
        console.log('[+] glShaderSource hooked');
    }
    const gcs = gles.getExportByName('glCompileShader');
    if (gcs) {
        Interceptor.attach(gcs, { onEnter(args) { console.log('[GLES] glCompileShader #' + args[0].toInt32()); } });
        console.log('[+] glCompileShader hooked');
    }
}

// ---- Vulkan 帧提交 ----
function hookVkQueue() {
    const presentPtr = findExport('vulkan.adreno.so', 'vkQueuePresentKHR');
    if (presentPtr) {
        Interceptor.attach(presentPtr, { onEnter() { console.log('[VK] vkQueuePresentKHR (Vulkan帧提交)'); } });
        console.log('[+] vkQueuePresentKHR hooked @ ' + presentPtr);
    } else {
        console.log('[-] vkQueuePresentKHR 导出未找到 (需GDPA)');
    }
    const submitPtr = findExport('vulkan.adreno.so', 'vkQueueSubmit');
    if (submitPtr) {
        Interceptor.attach(submitPtr, { onEnter() { console.log('[VK] vkQueueSubmit'); } });
        console.log('[+] vkQueueSubmit hooked @ ' + submitPtr);
    }
}

// ---- Vulkan shader module 替换 + GDPA 追踪 ----
function hookVulkanLayer() {
    let realCSMPtr = findExport('vulkan.adreno.so', 'vkCreateShaderModule')
        || findExport('libvulkan.so', 'vkCreateShaderModule');
    if (!realCSMPtr) { console.log('[-] real vkCreateShaderModule 未找到'); return; }
    const realCSM = new NativeFunction(realCSMPtr, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);
    console.log('[+] real vkCreateShaderModule @ ' + realCSMPtr);

    const wrapper = new NativeCallback(function (device, pCreateInfo, pAllocator, pShaderModule) {
        try {
            const codeSize = pCreateInfo.add(24).readU64().toNumber();
            if (codeSize > 100 && codeSize < 200000) {
                const pCode = pCreateInfo.add(32).readPointer();
                const fp = fnv1a(pCode.readByteArray(Math.min(codeSize, 65536)));
                if (fp === TARGET_HASH && replacementSpv) {
                    pCode.writeByteArray(replacementSpv);
                    pCreateInfo.add(24).writeU64(replacementSize);
                    console.log('[VK] ★★ RED-TEST 替换 (' + codeSize + '->' + replacementSize + 'B, codeSize覆写)');
                }
            }
        } catch (e) { console.log('[WRAPPER-ERR] ' + e); }
        return realCSM(device, pCreateInfo, pAllocator, pShaderModule);
    }, 'uint32', ['pointer', 'pointer', 'pointer', 'pointer']);

    const gdpa = findExport('libvulkan.so', 'vkGetDeviceProcAddr');
    if (gdpa) {
        Interceptor.attach(gdpa, {
            onEnter(args) { this.reqName = args[1].isNull() ? '?' : args[1].readCString(); },
            onLeave(retval) {
                const n = this.reqName;
                if (n === 'vkCreateShaderModule') {
                    retval.replace(wrapper);
                }
                if (n.indexOf('vkCreateGraphicsPipelines') === 0 || n === 'vkQueuePresentKHR' || n === 'vkQueueSubmit' || n === 'vkCmdDraw' || n === 'vkCmdDrawIndexed') {
                    console.log('[GDPA] ' + n + ' -> ' + retval);
                }
            }
        });
        console.log('[+] vkGetDeviceProcAddr hooked');
    }
}

setTimeout(() => {
    console.log('[+] Sky 渲染API定位启动');
    loadReplacement();
    hookVulkanLayer();
    hookEgl();
    hookGlesShaders();
    hookVkQueue();
    console.log('[+] 就绪');
}, 0);