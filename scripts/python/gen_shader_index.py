#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 intl_shaders_glsl_full 完整索引 + 同名变体统计"""
import os, glob

D = '/storage/emulated/0/Download/123云盘/Sky.LA(2018)/_analysis/intl_shaders_glsl_full'
ANA = '/storage/emulated/0/Download/123云盘/Sky.LA(2018)/_analysis'

rows = []
for f in glob.glob(D + '/*.glsl'):
    n = sum(1 for _ in open(f, errors='ignore'))
    rows.append((n, os.path.basename(f)))
rows.sort(reverse=True)

with open(ANA + '/shader_full_index.txt', 'w') as out:
    for n, b in rows:
        out.write('%d %s\n' % (n, b))

print('索引: %d 条, 总行数: %d' % (len(rows), sum(r[0] for r in rows)))
print('Top10:')
for n, b in rows[:10]:
    print('  %6d %s' % (n, b))

common = [l.strip() for l in open(ANA + '/intl_common_2018.txt') if l.strip()]
print('\n2018同名基名 %d 个, 各基名的 2026 变体数:' % len(common))
for base in common:
    cnt = sum(1 for b in os.listdir(D) if b.startswith(base) and b.endswith('.glsl'))
    if cnt:
        print('  %s: %d' % (base, cnt))