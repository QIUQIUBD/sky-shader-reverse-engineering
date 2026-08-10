#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sky 安卓版 shader 检测工具 (detect_android_shaders.py)
=====================================================
用法: python3 detect_android_shaders.py <国际服APK路径> [--dump 输出目录]

功能:
  1. 读取 APK (zipfile, 不解压)
  2. 自动定位 shader 资源 (assets/Shaders, *.vert/*.frag/*.spv/*.glsl 等)
  3. 检测 shader 格式: GLSL明文 / SPIR-V / 平台二进制 / 加密
  4. 与 2018 版清单 (_analysis/shaders/shaders_inventory.txt) 对比生成 diff 报告
  5. 可选 --dump: 提取全部 shader 源到目录

格式魔数:
  GLSL 明文: 文本 "#version 300 es" / "#version 310 es"
  SPIR-V:    0x07230203 (7 23 02 03)
  Metal:     "MTLB"
  DXBC:      "DXBC"
"""

import sys
import os
import re
import zipfile
import struct

# 2018 版清单 (相对本脚本路径)
INV_2018 = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        'shaders', 'shader_inventory.txt')

SHADER_EXTS = ('.vert', '.frag', '.vsh', '.fsh', '.glsl', '.spv',
               '.metallib', '.hlsl', '.fx', '.comp', '.tesc', '.tese', '.geom')
SHADER_DIRS = ('shaders', 'shader', 'shaderbin', 'assets/shaders')


def detect_format(data: bytes) -> str:
    if len(data) >= 4:
        if data[:4] == b'\x07\x23\x02\x03':
            return 'SPIR-V'
        if data[:4] == b'MTLB':
            return 'Metal-metallib'
        if data[:4] == b'DXBC':
            return 'DXBC'
    head = data[:512].lower()
    if b'#version' in head or b'void main' in head:
        m = re.search(rb'#version\s+(\S+)', data[:1024])
        return f'GLSL明文 (ES {m.group(1).decode() if m else "?"})'
    if b'glsl' in head or b'vulkan' in head:
        return 'GLSL(嵌入式/疑似)'
    # 高熵 = 二进制
    if len(data) > 64:
        sample = data[:4096]
        zeros = sample.count(0)
        if zeros / max(len(sample), 1) < 0.05:
            return '二进制(高熵,可能加密)'
    return '未知'


def scan_apk(apk_path: str):
    print(f'[1] 打开 APK: {apk_path}')
    zf = zipfile.ZipFile(apk_path)
    names = zf.namelist()
    print(f'    共 {len(names)} 个条目')

    # 定位 shader 文件
    shader_files = [n for n in names
                    if n.lower().endswith(SHADER_EXTS)
                    or any(d in n.lower() for d in SHADER_DIRS)
                    and ('.' in n.split('/')[-1])]
    print(f'[2] 疑似 shader 文件: {len(shader_files)}')

    if not shader_files:
        print('    !! 未找到独立 shader 文件, 可能内嵌于二进制或自定义容器')
        print('    !! 尝试扫描资源目录结构:')
        top = sorted(set(n.split('/')[0] for n in names if '/' in n))
        print('       ' + ', '.join(top[:40]))
        return

    fmt_count = {}
    glsl_files, spv_files = [], []
    for n in shader_files:
        try:
            data = zf.read(n)
        except Exception:
            continue
        fmt = detect_format(data)
        fmt_count[fmt] = fmt_count.get(fmt, 0) + 1
        if fmt.startswith('GLSL'):
            glsl_files.append(n)
        elif fmt == 'SPIR-V':
            spv_files.append(n)

    print(f'[3] 格式分布:')
    for k, v in sorted(fmt_count.items(), key=lambda x: -x[1]):
        print(f'      {v:5d}  {k}')

    # 与 2018 清单对比
    inv18 = set()
    if os.path.exists(INV_2018):
        with open(INV_2018) as f:
            inv18 = {l.strip() for l in f if l.strip()}
    print(f'[4] 2018 版 shader 清单: {len(inv18)} 个唯一名')

    # 提取 shader 基名
    base_names = set()
    for n in glsl_files + spv_files:
        b = os.path.basename(n)
        b = re.sub(r'\d+\.(vert|frag|comp|vsh|fsh)$', r'.\1', b)
        b = re.sub(r'\.(vert|frag|comp|vsh|fsh|spv)$', '', b)
        base_names.add(b)
    common = base_names & inv18
    new_only = base_names - inv18
    print(f'[5] 与 2018 同名(可直接对比): {len(common)}')
    print(f'     新增(2018没有): {len(new_only)}')
    if common:
        print(f'     同名示例: {sorted(common)[:30]}')
    print()
    if glsl_files:
        print('[结论] 安卓版为 GLSL 明文 → 可直接用 2018 源替换, 无需重编译!')
        print('       替换步骤见 15_android_replace_guide.md')
    elif spv_files:
        print('[结论] 安卓版为 SPIR-V → 需要 SPIRV-Cross 反编译或按新版管线重编译')
    else:
        print('[结论] 格式未知/加密 → 需要进一步逆向资源容器')

    return glsl_files, spv_files, shader_files


def dump_files(apk_path, glsl_files, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    zf = zipfile.ZipFile(apk_path)
    n = 0
    for f in glsl_files:
        out = os.path.join(out_dir, f.replace('/', '__'))
        with open(out, 'wb') as fo:
            fo.write(zf.read(f))
        n += 1
    print(f'[dump] 已提取 {n} 个 GLSL 源到 {out_dir}/')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    apk = sys.argv[1]
    g, s, allf = scan_apk(apk)
    if '--dump' in sys.argv and g:
        i = sys.argv.index('--dump')
        out = sys.argv[i + 1] if len(sys.argv) > i + 1 else 'dump_glsl'
        dump_files(apk, g, out)
