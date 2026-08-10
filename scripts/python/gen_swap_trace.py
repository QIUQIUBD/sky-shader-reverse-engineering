#!/usr/bin/env python3
"""生成 hook_swap_trace.js: AAsset 层打印所有 .spv 读取文件名 (仅文件名, 零开销)"""
src = open('/sdcard/Download/hook_swap_lite.js').read()

old = """                } else if (MODE === 'swap') {
                    if (name.indexOf('Tonemap_rec709') >= 0 && name.indexOf('.fs.spv') >= 0) {"""
new = """                } else if (MODE === 'swap') {
                    if (name.indexOf('.spv') >= 0) console.log(`[AAsset] ${name}`);
                    if (name.indexOf('Tonemap_rec709') >= 0 && name.indexOf('.fs.spv') >= 0) {"""
assert old in src, '未匹配'
src = src.replace(old, new)

open('/sdcard/Download/hook_swap_trace.js', 'w').write(src)
print('hook_swap_trace.js 生成完成')