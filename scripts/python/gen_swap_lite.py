#!/usr/bin/env python3
"""生成 hook_swap_lite.js: 精简 hook 开销 (swap 模式去掉每读指纹计算)"""
src = open('/sdcard/Download/hook_swap.js').read()

# 替换1: AAsset 层 — swap 模式不计算指纹 (只文件名匹配), 指纹仅在 dump 模式计算
old_asset = """                const name = assetNames.get(this.asset.toString()) || '?';
                const data = this.buf.readByteArray(Math.min(n, 4096));
                const fp = sha256hex(data);
                if (MODE === 'dump') {
                    if (n >= 5000 && n <= 30000) console.log(`[AAsset] read ${n} bytes fp=${fp} name=${name}`);
                } else if (MODE === 'swap') {"""
new_asset = """                const name = assetNames.get(this.asset.toString()) || '?';
                if (MODE === 'dump') {
                    const data = this.buf.readByteArray(Math.min(n, 4096));
                    const fp = sha256hex(data);
                    if (n >= 5000 && n <= 30000) console.log(`[AAsset] read ${n} bytes fp=${fp} name=${name}`);
                } else if (MODE === 'swap') {"""
assert old_asset in src, 'asset 段未匹配'
src = src.replace(old_asset, new_asset)

# 替换2: VK wrapper — 只对 15-30KB 模块算指纹 (Tonemap fs 大小范围)
old_vk = """            const fp = sha256hex(pCode.readByteArray(Math.min(codeSize, 65536)));
            if (MODE === 'dump') {"""
new_vk = """            if (codeSize < 15000 || codeSize > 30000) {
                return realCSM(device, pCreateInfo, pAllocator, pShaderModule);
            }
            const fp = sha256hex(pCode.readByteArray(Math.min(codeSize, 65536)));
            if (MODE === 'dump') {"""
assert old_vk in src, 'VK 段未匹配'
src = src.replace(old_vk, new_vk)

open('/sdcard/Download/hook_swap_lite.js', 'w').write(src)
print('hook_swap_lite.js 生成完成')
print('sha256hex 调用点:', src.count('sha256hex('))
