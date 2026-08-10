#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
轻量 SPIR-V 解析器 (spirv_info.py)
==================================
用途: 无 spirv-cross 环境下, 提取 SPIR-V 的关键结构信息:
  - 入口点 (OpEntryPoint)
  - 名称表 (OpName: uniform/输入输出/函数名)
  - 装饰 (OpDecorate: location/binding/descriptor_set/精度)
  - 能力与扩展 (OpCapability/OpExtension)
  - 指令统计

用法: python3 spirv_info.py <file.spv> [--full]
"""

import sys
import struct

# SPIR-V 魔数
MAGIC = 0x07230203

# 常用 OpCode (SPIR-V 1.3 标准)
OP = {
    0: 'OpNop', 1: 'OpUndef', 2: 'OpSourceContinued', 3: 'OpSource',
    4: 'OpSourceExtension', 5: 'OpName', 6: 'OpMemberName', 7: 'OpString',
    8: 'OpLine', 10: 'OpExtension', 11: 'OpExtInstImport', 12: 'OpExtInst',
    14: 'OpMemoryModel', 15: 'OpEntryPoint', 16: 'OpExecutionMode',
    17: 'OpCapability', 19: 'OpTypeVoid', 20: 'OpTypeBool',
    21: 'OpTypeInt', 22: 'OpTypeFloat', 23: 'OpTypeVector', 24: 'OpTypeMatrix',
    25: 'OpTypeImage', 26: 'OpTypeSampler', 27: 'OpTypeSampledImage',
    28: 'OpTypeArray', 29: 'OpTypeRuntimeArray', 30: 'OpTypeStruct',
    31: 'OpTypeOpaque', 32: 'OpTypePointer', 33: 'OpTypeFunction',
    34: 'OpTypeEvent', 35: 'OpTypeDeviceEvent', 36: 'OpTypeReserveId',
    37: 'OpTypeQueue', 38: 'OpTypePipe', 39: 'OpTypeForwardPointer',
    41: 'OpConstantTrue', 42: 'OpConstantFalse', 43: 'OpConstant',
    44: 'OpConstantComposite', 45: 'OpConstantSampler', 46: 'OpConstantNull',
    48: 'OpSpecConstantTrue', 49: 'OpSpecConstantFalse', 50: 'OpSpecConstant',
    51: 'OpSpecConstantComposite', 52: 'OpSpecConstantOp',
    54: 'OpFunction', 55: 'OpFunctionParameter', 56: 'OpFunctionEnd',
    57: 'OpFunctionCall', 59: 'OpVariable', 61: 'OpLoad', 62: 'OpStore',
    63: 'OpCopyMemory', 64: 'OpCopyMemorySized', 65: 'OpAccessChain',
    66: 'OpInBoundsAccessChain', 67: 'OpPtrAccessChain', 68: 'OpArrayLength',
    69: 'OpGenericPtrMemSemantics', 70: 'OpInBoundsPtrAccessChain',
    71: 'OpDecorate', 72: 'OpMemberDecorate', 73: 'OpDecorationGroup',
    74: 'OpGroupDecorate', 75: 'OpGroupMemberDecorate', 76: 'OpVectorShuffle',
    77: 'OpCompositeConstruct', 78: 'OpCompositeExtract', 79: 'OpCompositeInsert',
    80: 'OpCopyObject', 81: 'OpTranspose', 82: 'OpSampledImage',
    83: 'OpImageSampleImplicitLod', 84: 'OpImageSampleExplicitLod',
    85: 'OpImageSampleDrefImplicitLod', 86: 'OpImageSampleDrefExplicitLod',
    87: 'OpImageSampleProjImplicitLod', 88: 'OpImageSampleProjExplicitLod',
    89: 'OpImageSampleProjDrefImplicitLod', 90: 'OpImageSampleProjDrefExplicitLod',
    91: 'OpImageFetch', 92: 'OpImageGather', 93: 'OpImageDrefGather',
    94: 'OpImageRead', 95: 'OpImageWrite', 96: 'OpImage', 97: 'OpImageQueryFormat',
    98: 'OpImageQueryOrder', 99: 'OpImageQuerySizeLod', 100: 'OpImageQuerySize',
    101: 'OpImageQueryLod', 102: 'OpImageQueryLevels', 103: 'OpImageQuerySamples',
    104: 'OpConvertFToU', 105: 'OpConvertFToS', 106: 'OpConvertSToF',
    107: 'OpConvertUToF', 108: 'OpUConvert', 109: 'OpSConvert', 110: 'OpFConvert',
    111: 'OpQuantizeToF16', 112: 'OpConvertPtrToU', 113: 'OpSatConvertSToU',
    114: 'OpSatConvertUToS', 115: 'OpConvertUToPtr', 116: 'OpPtrCastToGeneric',
    117: 'OpGenericCastToPtr', 118: 'OpGenericCastToPtrExplicit',
    119: 'OpBitcast', 124: 'OpSNegate', 126: 'OpFNegate', 128: 'OpIAdd',
    129: 'OpFAdd', 130: 'OpISub', 131: 'OpFSub', 132: 'OpIMul', 133: 'OpFMul',
    134: 'OpUDiv', 135: 'OpSDiv', 136: 'OpFDiv', 137: 'OpUMod', 138: 'OpSRem',
    139: 'OpSMod', 140: 'OpFRem', 141: 'OpFMod', 142: 'OpVectorTimesScalar',
    143: 'OpMatrixTimesScalar', 144: 'OpVectorTimesMatrix',
    145: 'OpMatrixTimesVector', 146: 'OpMatrixTimesMatrix', 147: 'OpOuterProduct',
    148: 'OpDot', 149: 'OpIAddCarry', 150: 'OpISubBorrow', 151: 'OpUMulExtended',
    152: 'OpSMulExtended', 154: 'OpAny', 155: 'OpAll', 156: 'OpIsNan',
    157: 'OpIsInf', 158: 'OpIsFinite', 159: 'OpIsNormal', 160: 'OpSignBitSet',
    161: 'OpLessOrGreater', 162: 'OpOrdered', 163: 'OpUnordered', 164: 'OpLogicalEqual',
    165: 'OpLogicalNotEqual', 166: 'OpLogicalOr', 167: 'OpLogicalAnd',
    168: 'OpLogicalNot', 169: 'OpSelect', 170: 'OpIEqual', 171: 'OpINotEqual',
    172: 'OpUGreaterThan', 173: 'OpSGreaterThan', 174: 'OpUGreaterThanEqual',
    175: 'OpSGreaterThanEqual', 176: 'OpULessThan', 177: 'OpSLessThan',
    178: 'OpULessThanEqual', 179: 'OpSLessThanEqual', 180: 'OpFOrdEqual',
    181: 'OpFUnordEqual', 182: 'OpFOrdNotEqual', 183: 'OpFUnordNotEqual',
    184: 'OpFOrdLessThan', 185: 'OpFUnordLessThan', 186: 'OpFOrdGreaterThan',
    187: 'OpFUnordGreaterThan', 188: 'OpFOrdLessThanEqual', 189: 'OpFUnordLessThanEqual',
    190: 'OpFOrdGreaterThanEqual', 191: 'OpFUnordGreaterThanEqual',
    194: 'OpShiftRightLogical', 195: 'OpShiftRightArithmetic', 196: 'OpShiftLeftLogical',
    197: 'OpBitwiseOr', 198: 'OpBitwiseXor', 199: 'OpBitwiseAnd', 200: 'OpNot',
    201: 'OpBitFieldInsert', 202: 'OpBitFieldSExtract', 203: 'OpBitFieldUExtract',
    204: 'OpBitReverse', 205: 'OpBitCount', 207: 'OpDPdx', 208: 'OpDPdy',
    209: 'OpFwidth', 210: 'OpDPdxFine', 211: 'OpDPdyFine', 212: 'OpFwidthFine',
    213: 'OpDPdxCoarse', 214: 'OpDPdyCoarse', 215: 'OpFwidthCoarse',
    218: 'OpEmitVertex', 219: 'OpEndPrimitive', 220: 'OpEmitStreamVertex',
    221: 'OpEndStreamPrimitive', 224: 'OpLoopMerge', 225: 'OpSelectionMerge',
    226: 'OpLabel', 227: 'OpBranch', 228: 'OpBranchConditional', 229: 'OpSwitch',
    230: 'OpKill', 231: 'OpReturn', 232: 'OpReturnValue', 233: 'OpUnreachable',
    234: 'OpLifetimeStart', 235: 'OpLifetimeStop', 236: 'OpGroupAsyncCopy',
    245: 'OpGroupWaitEvents', 246: 'OpGroupAll', 247: 'OpGroupAny',
    248: 'OpGroupBroadcast', 249: 'OpGroupIAdd', 250: 'OpGroupFAdd',
    251: 'OpGroupFMin', 252: 'OpGroupUMin', 253: 'OpGroupSMin', 254: 'OpGroupFMax',
    255: 'OpGroupUMax', 256: 'OpGroupSMax', 257: 'OpReadPipe', 258: 'OpWritePipe',
    263: 'OpReservedReadPipe', 264: 'OpReservedWritePipe',
    268: 'OpConstantPipeStorage', 269: 'OpCreatePipeFromPipeStorage',
    270: 'OpGetKernelNumSubgroups', 271: 'OpGetKernelMaxNumSubgroups',
    272: 'OpGetKernelWorkGroupSize', 273: 'OpGetKernelLocalSizeForSubgroupCount',
    274: 'OpGetKernelMaxNumSubgroupsWithLocalSize', 275: 'OpGetKernelWorkGroupSize',
    276: 'OpGetKernelLocalSizeForSubgroupCount', 284: 'OpSubgroupBallotKHR',
    299: 'OpSubgroupAllKHR', 300: 'OpSubgroupAnyKHR', 301: 'OpSubgroupAllEqualKHR',
    302: 'OpGroupNonUniformElect', 303: 'OpGroupNonUniformAll',
    304: 'OpGroupNonUniformAny', 305: 'OpGroupNonUniformAllEqual',
    306: 'OpGroupNonUniformBroadcast', 307: 'OpGroupNonUniformBroadcastFirst',
    308: 'OpGroupNonUniformBallot', 309: 'OpGroupNonUniformInverseBallot',
    310: 'OpGroupNonUniformBallotBitExtract', 311: 'OpGroupNonUniformBallotBitCount',
    312: 'OpGroupNonUniformBallotFindLSB', 313: 'OpGroupNonUniformBallotFindMSB',
    314: 'OpGroupNonUniformShuffle', 315: 'OpGroupNonUniformShuffleXor',
    316: 'OpGroupNonUniformShuffleUp', 317: 'OpGroupNonUniformShuffleDown',
    318: 'OpGroupNonUniformIAdd', 319: 'OpGroupNonUniformFAdd',
    320: 'OpGroupNonUniformIMul', 321: 'OpGroupNonUniformFMul',
    322: 'OpGroupNonUniformSMin', 323: 'OpGroupNonUniformUMin',
    324: 'OpGroupNonUniformFMin', 325: 'OpGroupNonUniformSMax',
    326: 'OpGroupNonUniformUMax', 327: 'OpGroupNonUniformFMax',
    328: 'OpGroupNonUniformBitwiseAnd', 329: 'OpGroupNonUniformBitwiseOr',
    330: 'OpGroupNonUniformBitwiseXor', 331: 'OpGroupNonUniformLogicalAnd',
    332: 'OpGroupNonUniformLogicalOr', 333: 'OpGroupNonUniformLogicalXor',
    334: 'OpGroupNonUniformQuadBroadcast', 335: 'OpGroupNonUniformQuadSwap',
    336: 'OpCopyLogical', 352: 'OpPtrEqual', 353: 'OpPtrNotEqual', 354: 'OpPtrDiff',
    400: 'OpTerminateInvocation', 401: 'OpSubgroupBallotKHR' if False else 0x190,
    441: 'OpDecorateString', 442: 'OpMemberDecorateString',
    443: 'OpDecorateId', 444: 'OpMemberDecorateId', 445: 'OpDecorationGroup',
    446: 'OpGroupDecorate', 447: 'OpGroupMemberDecorate', 448: 'OpTypeForwardPointer',
    449: 'OpModuleProcessed', 450: 'OpExecutionModeId', 451: 'OpDecorateStringGOOGLE',
    452: 'OpMemberDecorateStringGOOGLE', 453: 'OpDecorateIdGOOGLE',
    454: 'OpMemberDecorateIdGOOGLE', 455: 'OpDecorationGroupGOOGLE',
    456: 'OpGroupDecorateGOOGLE', 457: 'OpGroupMemberDecorateGOOGLE',
    458: 'OpTypeForwardPointerGOOGLE', 459: 'OpModuleProcessedGOOGLE',
    460: 'OpExecutionModeIdGOOGLE',
    5240: 'OpCooperativeMatrixLoadNV', 5241: 'OpCooperativeMatrixStoreNV',
    5256: 'OpRayQueryInitializeKHR', 5257: 'OpRayQueryTerminateKHR',
    5258: 'OpRayQueryGenerateIntersectionKHR', 5259: 'OpRayQueryConfirmIntersectionKHR',
    5260: 'OpRayQueryProceedKHR', 5261: 'OpRayQueryGetIntersectionTypeKHR',
    5312: 'OpExecuteCallableKHR', 5313: 'OpTraceRayKHR', 5328: 'OpHitObjectRecordHitMotionNV',
    5339: 'OpReportIntersectionKHR', 5340: 'OpIgnoreIntersectionKHR',
    5341: 'OpTerminateRayKHR', 5367: 'OpTraceRayMotionNV',
}

DECORATION = {
    0: 'None', 1: 'Block', 2: 'BufferBlock', 3: 'RowMajor', 4: 'ColMajor',
    5: 'ArrayStride', 6: 'MatrixStride', 7: 'GLSLShared', 8: 'GLSLPacked',
    9: 'CPacked', 10: 'BuiltIn', 11: 'NoPerspective', 12: 'Flat',
    13: 'Patch', 14: 'Centroid', 15: 'Sample', 16: 'Invariant',
    17: 'Restrict', 18: 'Aliased', 19: 'Volatile', 20: 'Constant',
    21: 'Coherent', 22: 'NonWritable', 23: 'NonReadable', 24: 'Uniform',
    25: 'SaturatedConversion', 26: 'Stream', 27: 'Location', 28: 'Component',
    29: 'Index', 30: 'Binding', 31: 'DescriptorSet', 32: 'Offset',
    33: 'XfbBuffer', 34: 'XfbStride', 35: 'FuncParamAttr', 36: 'FPRoundingMode',
    37: 'FPFastMathMode', 38: 'LinkageAttributes', 39: 'NoContraction',
    40: 'InputAttachmentIndex', 41: 'Alignment', 42: 'MaxByteOffset',
    43: 'AlignmentId', 44: 'MaxByteOffsetId', 45: 'NoSignedWrap', 46: 'NoUnsignedWrap',
    4467: 'NonUniform', 4468: 'RestrictPointer', 4469: 'AliasedPointer',
    4470: 'CounterBuffer', 4471: 'UserSemantic', 4472: 'UserTypeGOOGLE',
    524290: 'RelaxedPrecision',
}

BUILTIN = {
    0: 'Position', 1: 'PointSize', 3: 'ClipDistance', 4: 'CullDistance',
    5: 'VertexId', 6: 'InstanceId', 7: 'PrimitiveId', 8: 'InvocationId',
    9: 'Layer', 10: 'ViewportIndex', 11: 'TessLevelOuter', 12: 'TessLevelInner',
    13: 'TessCoord', 14: 'PatchVertices', 15: 'FragCoord', 16: 'PointCoord',
    17: 'FrontFacing', 18: 'SampleId', 19: 'SamplePosition', 20: 'SampleMask',
    21: 'FragDepth', 22: 'HelperInvocation', 23: 'NumWorkgroups',
    24: 'WorkgroupSize', 25: 'WorkgroupId', 26: 'LocalInvocationId',
    27: 'GlobalInvocationId', 28: 'LocalInvocationIndex', 29: 'WorkDim',
    30: 'GlobalSize', 31: 'EnqueuedWorkgroupSize', 32: 'GlobalOffset',
    33: 'GlobalLinearId', 34: 'SubgroupSize', 35: 'SubgroupMaxSize',
    36: 'NumSubgroups', 37: 'NumEnqueuedSubgroups', 38: 'SubgroupId',
    39: 'SubgroupLocalInvocationId', 40: 'VertexIndex', 41: 'InstanceIndex',
    42: 'SubgroupEqMask', 43: 'SubgroupGeMask', 44: 'SubgroupGtMask',
    45: 'SubgroupLeMask', 46: 'SubgroupLtMask', 47: 'BaseVertex',
    48: 'BaseInstance', 49: 'DrawIndex', 50: 'DeviceIndex',
    51: 'ViewIndex', 4423: 'BaryCoordKHR', 4426: 'FragStencilRefEXT',
}

EXEC_MODEL = {0: 'Vertex', 1: 'TessellationControl', 2: 'TessellationEvaluation',
              3: 'Geometry', 4: 'Fragment', 5: 'GLCompute', 6: 'Kernel',
              5267: 'TaskNV', 5268: 'MeshNV', 5313: 'RayGenerationKHR'}


def read_string(words, idx):
    """从 word 数组 idx 位置读取 null 结尾字符串, 返回 (str, 消耗word数)"""
    parts = []
    consumed = 0
    for i in range(idx, len(words)):
        w = words[i]
        raw = struct.pack('<I', w & 0xFFFFFFFF)
        parts.append(raw)
        consumed += 1
        if b'\x00' in raw:
            break
    s = b''.join(parts).split(b'\x00')[0].decode('utf-8', 'replace')
    return s, consumed


def parse(path, full=False):
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) < 20:
        print(f'[!] 文件过小: {len(data)} bytes')
        return
    magic, ver, gen_magic, bound, schema = struct.unpack('<IIIII', data[:20])
    if magic != MAGIC:
        print(f'[!] 非 SPIR-V (魔数 0x{magic:08X})')
        return
    ver_major, ver_minor = (ver >> 16) & 0xFF, (ver >> 8) & 0xFF
    print(f'== SPIR-V 信息: {path}')
    print(f'   版本 {ver_major}.{ver_minor}  生成器 0x{gen_magic:04X}  bound={bound}')

    # 解析指令流
    words = list(struct.unpack(f'<{len(data[20:]) // 4}I', data[20:]))
    ops = []
    i = 0
    while i < len(words):
        w0 = words[i]
        wc = w0 >> 16
        op = w0 & 0xFFFF
        if wc == 0 or i + wc > len(words):
            print(f'[!] 指令流异常 @word{i}')
            break
        ops.append((op, words[i + 1:i + wc]))
        i += wc

    names = {}          # id -> name
    entry_points = []   # (model, id, name)
    decorations = {}    # id -> [(dec, args)]
    capabilities = []
    extensions = set()
    member_names = {}
    type_names = {}     # id -> type描述(粗略)

    for op, args in ops:
        if op == 4:   # OpName
            tid = args[0]
            s, _ = read_string(args, 1)
            names[tid] = s
        elif op == 5: # OpMemberName
            member_names.setdefault(args[0], {})[args[1]] = read_string(args, 2)[0]
        elif op == 15:  # OpEntryPoint
            model = args[0]
            eid = args[1]
            s, _ = read_string(args, 2)
            entry_points.append((model, eid, s))
        elif op == 71:  # OpDecorate
            tid = args[0]
            dec = args[1]
            decorations.setdefault(tid, []).append((dec, args[2:]))
        elif op == 17:  # OpCapability
            capabilities.append(args[0])
        elif op == 3:   # OpSourceExtension
            s, _ = read_string(args, 0)
            extensions.add(s)

    print(f'   指令数: {len(ops)}  能力: {capabilities}')
    if extensions:
        print(f'   扩展: {sorted(extensions)}')
    print(f'   入口点:')
    for model, eid, name in entry_points:
        print(f'     [{EXEC_MODEL.get(model, model)}] "{name}" (id={eid})')

    # 汇总 uniform/输入输出
    print(f'   调试名(OpName)数量: {len(names)}')
    print(f'\n   变量装饰 (id: 名称 | location/binding/set | 装饰):')
    for tid in sorted(decorations):
        nm = names.get(tid, f'<id_{tid}>')
        decs = decorations[tid]
        parts = []
        for dec, args in decs:
            if dec == 27:      # Location
                parts.append(f'loc={args[0]}')
            elif dec == 30:    # Binding
                parts.append(f'bind={args[0]}')
            elif dec == 31:    # DescriptorSet
                parts.append(f'set={args[0]}')
            elif dec == 10:    # BuiltIn
                parts.append(f'builtin={BUILTIN.get(args[0], args[0])}')
            elif dec == 1 or dec == 2:  # Block/BufferBlock
                parts.append('Block')
            else:
                parts.append(DECORATION.get(dec, f'dec{dec}'))
        print(f'     {tid:4d} {nm:40s} | {", ".join(parts)}')

    if full:
        print(f'\n   类型名称 (OpType* 相关):')
        for tid, nm in names.items():
            if nm.startswith('type.') or 'type' in nm.lower():
                print(f'     {tid}: {nm}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    full = '--full' in sys.argv
    parse(sys.argv[1], full)