#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TGC Sky Gold Lua fork bytecode disassembler — FINAL v2
======================================================
决定性结论 (2026-08 第四轮逆向, 已用官方 lua-5.2.4 源码 + luac5.2 对照验证):
  * TGC .luac = 官方 Lua 5.2.4 字节码格式, 唯一差异:
      sizeof(size_t)=4 (TGC 32位size_t构建) vs 官方 8
    头部 18 字节完全标准: \x1bLua + version(0x52) + format(0) + endian(1)
      + sizeof(int)=4 + sizeof(size_t)=4 + sizeof(Instruction)=4
      + sizeof(lua_Number)=8 + integral(0) + LUAC_TAIL(\x19\x93\r\n\x1a\n)
  * opcode 表 = 官方 luaP_opnames (0..39) — 已通过二进制 __DATA:0x100c291f0 验证
  * 指令布局 = 官方 (opcode低6位, A=>>6, B=>>23, C=>>14, Bx/sBx=>>14)
  * 字段顺序 = 官方 lundump.c LoadFunction:
      linedefined, lastlinedefined, numparams, is_vararg, maxstacksize,
      LoadCode, LoadConstants(+LoadProtos内嵌), LoadUpvalues, LoadDebug
Usage: python3 luadump52.py <file.luac> [--strings-only] [--depth N]
"""
import struct, sys

# 官方 Lua5.2 luaP_opnames (已验证)
OPCODES = [
    "MOVE","LOADK","LOADKX","LOADBOOL","LOADNIL","GETUPVAL","GETTABUP","GETTABLE",
    "SETTABUP","SETUPVAL","SETTABLE","NEWTABLE","SELF","ADD","SUB","MUL","DIV",
    "MOD","POW","UNM","NOT","LEN","CONCAT","JMP","EQ","LT","LE","TEST","TESTSET",
    "CALL","TAILCALL","RETURN","FORLOOP","FORPREP","TFORCALL","TFORLOOP","SETLIST",
    "CLOSURE","VARARG","EXTRAARG",
]
MAXARG_Bx = 0x3FFFF
MAXARG_sBx = 0x1FFFF


class Reader:
    def __init__(self, data, off, big_endian):
        self.data = data
        self.off = off
        self.e = '>' if big_endian else '<'

    def byte(self):
        v = self.data[self.off]
        self.off += 1
        return v

    def int4(self):
        v = struct.unpack_from(self.e + 'i', self.data, self.off)[0]
        self.off += 4
        return v

    def uint4(self):
        v = struct.unpack_from(self.e + 'I', self.data, self.off)[0]
        self.off += 4
        return v

    def ins4(self):
        return self.uint4()

    def num8(self):
        v = struct.unpack_from(self.e + 'd', self.data, self.off)[0]
        self.off += 8
        return v

    def string(self):
        """Lua5.2 LoadString: size_t(4B) 长度前缀含结尾\\0; 0 => NULL"""
        n = self.uint4()
        if n == 0:
            return None
        raw = self.data[self.off:self.off + n - 1]
        self.off += n
        return raw.decode('utf-8', 'replace')


def load_function(r, depth=0, maxdepth=64, strings_only=False, out=None):
    ind = '  ' * depth
    linedefined = r.int4()
    lastlinedefined = r.int4()
    numparams = r.byte()
    is_vararg = r.byte()
    maxstack = r.byte()

    # LoadCode
    ncode = r.int4()
    code = [r.ins4() for _ in range(ncode)]

    # LoadConstants
    nk = r.int4()
    consts = []
    for _ in range(nk):
        t = r.byte()
        if t == 0:      # LUA_TNIL
            consts.append(('NIL',))
        elif t == 1:    # LUA_TBOOLEAN
            consts.append(('BOOL', r.byte() != 0))
        elif t == 3:    # LUA_TNUMBER
            consts.append(('NUM', r.num8()))
        elif t == 4:    # LUA_TSTRING
            consts.append(('STR', r.string()))
        else:
            raise ValueError(f'未知常量类型 t={t} @0x{r.off-1:x}')

    # LoadProtos (内嵌在 LoadConstants 之后)
    np = r.int4()
    protos = []
    for _ in range(np):
        p = load_function(r, depth + 1, maxdepth, strings_only, out)
        protos.append(p)

    # LoadUpvalues (instack, idx)
    nup = r.int4()
    upvals = []
    for _ in range(nup):
        instack = r.byte()
        idx = r.byte()
        upvals.append((instack, idx))

    # LoadDebug: source, lineinfo, locvars, upvalue names
    source = r.string()
    nline = r.int4()
    lineinfo = [r.int4() for _ in range(nline)]
    nloc = r.int4()
    locvars = []
    for _ in range(nloc):
        name = r.string()
        startpc = r.int4()
        endpc = r.int4()
        locvars.append((name, startpc, endpc))
    nupn = r.int4()
    upnames = [r.string() for _ in range(nupn)]

    proto = dict(source=source, linedefined=linedefined, lastlinedefined=lastlinedefined,
                 numparams=numparams, is_vararg=is_vararg, maxstack=maxstack,
                 code=code, consts=consts, protos=protos, upvals=upvals,
                 locvars=locvars, upnames=upnames)

    if not strings_only:
        out.write(f"{ind}-- func {source} lines {linedefined}-{lastlinedefined} "
                  f"params={numparams} vararg={is_vararg} stack={maxstack} "
                  f"code={len(code)} consts={len(consts)} upvals={len(upvals)} "
                  f"protos={len(protos)}\n")
        for i, c in enumerate(consts):
            if c[0] in ('STR', 'NUM', 'BOOL'):
                out.write(f"{ind}  CONST[{i}] = {c[1]!r}\n")
        for pc, ins in enumerate(code):
            op = ins & 0x3F
            a = (ins >> 6) & 0xFF
            b = (ins >> 23) & 0x1FF
            c = (ins >> 14) & 0x1FF
            bx = (ins >> 14) & MAXARG_Bx
            sbx = bx - MAXARG_sBx
            name = OPCODES[op] if op < len(OPCODES) else f'OP{op}'
            line = f"{ind}  [{pc:4d}] {name:10s} A={a}"
            if name in ('MOVE', 'LOADBOOL', 'LOADNIL', 'GETUPVAL', 'SETUPVAL',
                        'SELF', 'TEST', 'TESTSET', 'CALL', 'TAILCALL', 'RETURN',
                        'TFORCALL', 'VARARG', 'GETTABLE', 'SETTABLE', 'GETTABUP',
                        'SETTABUP', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'POW',
                        'EQ', 'LT', 'LE', 'CONCAT', 'NEWTABLE'):
                line += f" B={b}"
                if name not in ('MOVE', 'LOADNIL', 'GETUPVAL', 'SETUPVAL', 'RETURN'):
                    line += f" C={c}"
            elif name in ('LOADK', 'LOADKX', 'CLOSURE', 'SETLIST'):
                line += f" Bx={bx}"
                if name == 'CLOSURE' and bx < len(protos):
                    line += f" ; proto[{bx}] {protos[bx]['source']}"
            elif name in ('JMP', 'FORLOOP', 'FORPREP', 'TFORLOOP'):
                line += f" sBx={sbx} ->{pc + 1 + sbx}"
            else:
                line += f" B={b} C={c}"
            out.write(line + "\n")
    else:
        for c in consts:
            if c[0] == 'STR':
                out.write(c[1] + "\n")
    return proto


def main():
    path = sys.argv[1]
    strings_only = '--strings-only' in sys.argv
    data = open(path, 'rb').read()

    if data[:4] != b'\x1bLua':
        print("Not a Lua bytecode file")
        return
    ver, fmt, endian, isz, szsz, inssz, numsz, integral = data[4], data[5], data[6], data[7], data[8], data[9], data[10], data[11]
    print(f"# Lua bytecode v{ver:#x} fmt={fmt} endian={endian}({'小端' if endian==1 else '大端'}) "
          f"int={isz} size_t={szsz} ins={inssz} num={numsz} integral={integral}")
    print(f"# LUAC_TAIL = {data[12:18].hex()} | 文件 {len(data)}B, Proto@18")
    if data[12:18] != b'\x19\x93\r\n\x1a\n':
        print("# WARNING: LUAC_TAIL 非标准!")

    be_ok = be_off = None
    le_ok = le_off = None
    for be in (True, False):
        r = Reader(data, 18, be)
        try:
            load_function(r, 0, 64, True, open('/dev/null', 'w'))
            if r.off >= len(data):
                if be:
                    be_ok = True
                else:
                    le_ok = True
        except Exception:
            pass
        if be:
            be_off = r.off
        else:
            le_off = r.off
    print(f"# 端序探测: BE完整={be_ok} (off={be_off}) | LE完整={le_ok} (off={le_off})")
    use_be = True if be_ok else (False if le_ok else None)
    if use_be is None:
        print("# 未能完整解析, 输出 BE 解析结果供调试")
        use_be = True
    print(f"# 采用{'大端' if use_be else '小端'}解析\n")

    r = Reader(data, 18, use_be)
    load_function(r, 0, 64, strings_only, sys.stdout)


if __name__ == '__main__':
    main()