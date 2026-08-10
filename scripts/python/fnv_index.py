#!/usr/bin/env python3
"""FNV-1a 指纹索引: 遍历 SPV 目录, 输出 fp->path 映射 (前4096字节, 与 hook_vkShaderModule.js 一致)"""
import os
import sys

def fnv1a(data):
    h = 0x811c9dc5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return ('00000000' + format(h, 'x'))[-8:]

root = sys.argv[1]
for dirpath, _, files in os.walk(root):
    for f in sorted(files):
        if f.endswith('.spv'):
            p = os.path.join(dirpath, f)
            with open(p, 'rb') as fh:
                d = fh.read(4096)
            fp = fnv1a(d)
            print(f'{fp}\t{os.path.relpath(p, root)}')
