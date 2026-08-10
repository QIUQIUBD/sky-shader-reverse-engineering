/*
 * diag4.js — 渲染路径最终定位 (attach 模式)
 * 关键认知: 游戏所有 device 函数经 GDPA 懒加载, 返回地址≠导出符号
 * 策略: GDPA onLeave 对关键函数 attach 真实地址
 * 目标: vkCreateGraphicsPipelines (Tonemap module 是否入管线) + vkQueuePresentKHR (帧提交)
 */
'use strict';

const hooked = {};

function findExport(moduleName, exportName) {
    try {
        const m = Process.findModuleByName(moduleName);
        return m ? m.getExportByName(exportName) : null;
    } catch (e) {
        return null;
    }
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
                                stages.push((stage === 0x10 ? 'FS' : stage === 0x8 ? 'VS' : stage === 0x20 ? 'CS' : 'S' + stage) + ':' + modHandle);
                            }
                            console.log('[PIPE-G] #' + i + ' stages=' + stages.join(' '));
                        }
                    } catch (e) { console.log('[PIPE-G-ERR] ' + e); }
                } else if (name === 'vkCreateComputePipelines') {
                    try {
                        const n = args[2].toInt32();
                        const pInfos = args[3];
                        for (let i = 0; i < n; i++) {
                            const modHandle = pInfos.add(i * 64).add(24).readPointer();
                            console.log('[PIPE-C] #' + i + ' CS:' + modHandle);
                        }
                    } catch (e) { console.log('[PIPE-C-ERR] ' + e); }
                } else if (name === 'vkQueuePresentKHR' || name === 'vkQueueSubmit') {
                    console.log('[VK] ' + name);
                } else if (name === 'vkCmdDraw' || name === 'vkCmdDrawIndexed') {
                    console.log('[VK] ' + name);
                } else if (name === 'vkCmdBindPipeline') {
                    console.log('[VK] vkCmdBindPipeline');
                }
            }
        });
        console.log('[+] hooked ' + name + ' @ ' + addr);
    } catch (e) {
        console.log('[-] hook ' + name + ' fail: ' + e);
    }
}

const gdpa = findExport('libvulkan.so', 'vkGetDeviceProcAddr');
if (gdpa) {
    Interceptor.attach(gdpa, {
        onEnter(args) { this.reqName = args[1].isNull() ? '?' : args[1].readCString(); },
        onLeave(retval) {
            const n = this.reqName;
            console.log('[GDPA] ' + n + ' -> ' + retval);
            if (n === 'vkCreateGraphicsPipelines' || n === 'vkCreateComputePipelines' ||
                n === 'vkQueuePresentKHR' || n === 'vkQueueSubmit' ||
                n === 'vkCmdDraw' || n === 'vkCmdDrawIndexed' || n === 'vkCmdBindPipeline') {
                hookReal(n, retval);
            }
        }
    });
    console.log('[+] GDPA hooked');
} else {
    console.log('[-] GDPA 未找到');
}

// 立即 hook 已知的 vkQueuePresentKHR (diag3 已确认地址)
hookReal('vkQueuePresentKHR', ptr('0x720f573554'));

setTimeout(() => {
    console.log('[+] diag4 就绪: GDPA追踪 + 关键函数hook');
}, 0);