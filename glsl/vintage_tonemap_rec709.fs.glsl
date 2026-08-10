// ============================================================================
// vintage_tonemap_rec709.fs.glsl — 2018 复古调色 → 2026 SPIR-V 移植版
// ============================================================================
// 原理: 以国际服 0.34.3 Tonemap_rec709 反编译骨架为外壳 (SPIRV-Cross 输出),
//       将主色调映射段 (ACES/Frostbite) 替换为 2018 版逻辑 (反色调映射+Bloom+暗角+Reinhard²)
// 来源: _analysis/intl_shaders_glsl/Tonemap_rec709.fs.glsl (2026)
//       _analysis/shaders/Bin/Tonemap0.frag (2018)
// 用法: glslangValidator -V vintage_tonemap_rec709.fs.glsl -o vintage.fs.spv
//       或 Frida 运行时注入 (见 hook_vkShaderModule.js)
//
// ⚠️ UBO 成员假设 (需真机验证, 见 17_vintage_port_guide.md §4):
//   _151._m0 = 场景颜色增益 vec3 (2018: 无, 设 1.0)
//   _151._m1 = 灰度混合系数 (2018: 0)
//   _151._m2 = u_exposure  (2018: u_exposure)
//   _151._m3 = u_bloomParams (x=混合, y=强度, z=?, w=曝光标志)
//   _151._m4 = 开关 (2018 无, 设 0)
//   _151._m5 = 色差开关 (2018 无, 设 0)
//   _151._m6 = 量化开关 (保留 2026)
//   纹理: _576(bind3)=场景, _592(bind5)=bloom, _376(bind4)=motionBlur, _709(bind6)=量化
// ============================================================================
#version 450
#if defined(GL_AMD_gpu_shader_half_float)
#extension GL_AMD_gpu_shader_half_float : require
#elif defined(GL_NV_gpu_shader5)
#extension GL_NV_gpu_shader5 : require
#else
#error No extension available for FP16.
#endif

// ---- 2026 巨型 UBO (保留原布局, 成员只读部分) ----
layout(set = 1, binding = 2, std140) uniform _111_113
{
    vec4 _m0;
    vec4 _m1;
    vec4 _m2;
    vec4 _m3;
    vec4 _m4;
    vec4 _m5;
    mat4 _m6;
    mat4 _m7;
    mat4 _m8;
    mat4 _m9;
    mat4 _m10;
    mat4 _m11;
    mat4 _m12;
    vec4 _m13;
    vec4 _m14;
    vec4 _m15;
    vec4 _m16;
    vec3 _m17;
    float _m18;
    float _m19;
    float _m20;
    float _m21;
    float _m22;
    float _m23;
    float _m24;
    float _m25;
    uint _m26;
    vec4 _m27;
    vec3 _m28;
    float _m29;
    vec3 _m30;
    float _m31;
    vec4 _m32;
    vec4 _m33;
    vec3 _m34;
    vec3 _m35;
    vec3 _m36;
    vec3 _m37;
    vec3 _m38;
    vec3 _m39;
    vec4 _m40;
    vec2 _m41;
    vec2 _m42;
    float _m43;
    vec3 _m44;
    float _m45;
    vec4 _m46;
    vec3 _m47;
    float _m48;
    vec3 _m49;
    float _m50;
    vec3 _m51;
    float _m52;
    vec3 _m53;
    vec3 _m54;
    vec4 _m55;
    vec4 _m56;
    float _m57;
    float _m58;
    float _m59;
    vec4 _m60;
    vec3 _m61;
    float _m62;
    vec4 _m63;
    vec4 _m64;
    vec4 _m65;
    vec4 _m66;
    vec3 _m67;
    vec3 _m68;
    vec3 _m69;
    vec3 _m70;
    vec4 _m71;
    vec4 _m72;
    vec4 _m73;
    vec4 _m74;
    vec4 _m75;
    vec4 _m76;
    vec3 _m77;
    vec3 _m78;
    vec4 _m79;
    vec4 _m80;
    vec4 _m81;
    vec4 _m82;
    vec3 _m83;
    vec3 _m84;
    vec3 _m85;
    float _m86;
    vec3 _m87;
    float _m88;
    vec3 _m89;
    vec3 _m90;
    float _m91;
    vec3 _m92;
    vec3 _m93;
    vec3 _m94;
    vec3 _m95;
    float _m96;
    vec4 _m97;
    uvec4 _m98;
} _113;

// ---- 2026 小 UBO (复古参数复用) ----
layout(set = 1, binding = 0, std140) uniform _149_151
{
    vec3 _m0;    // [复古] 场景增益 (2018无 -> 恒1.0)
    float _m1;   // [复古] 灰度混合系数 (2018无 -> 0.0)
    float _m2;   // [复古] u_exposure
    vec4 _m3;    // [复古] u_bloomParams (x=bloom混合, y=bloom强度)
    float _m4;   // [保留] 开关
    float _m5;   // [保留] 色差开关
    ivec4 _m6;   // [保留] 量化参数
} _151;

layout(set = 1, binding = 4) uniform sampler2D _376;   // [复古] u_texMotionBlur
layout(set = 1, binding = 7) uniform sampler2D _490;   // [保留] 镜头畸变查找表
layout(set = 1, binding = 3) uniform sampler2D _576;   // [复古] u_texFull (场景)
layout(set = 1, binding = 5) uniform sampler2D _592;   // [复古] u_bloomTex
layout(set = 1, binding = 6) uniform sampler2D _709;   // [保留] 量化纹理

layout(location = 0) in vec2 _379;            // uv
layout(location = 0) out vec4 _685;           // 输出

void main()
{
    // ========== 2026 外壳: 镜头畸变修正 (保留) ==========
    vec2 _485 = _379 - vec2(0.5);
    vec2 _491 = _485;
    vec2 _784 = _491;
    _784.y *= _113._m4.x;
    vec2 _785 = vec2(dot(_784, _784) * _113._m4.y, 0.5);
    vec2 _786 = textureLod(_490, _785, 0.0).xy;
    vec2 _787 = _784 * _786;
    vec2 _489 = _787 + vec2(0.5);

    float16_t _495 = float16_t(abs(_485.y) < _113._m4.z);
    float16_t _503 = float16_t(_113._m3.x);
    float16_t _507 = float16_t(_113._m3.y);
    float16_t _511 = float16_t(_113._m3.z);
    float _515 = _151._m3.w;
    float16_t _518 = step(float16_t(1.0), float16_t(_515));
    float16_t _522 = mix(float16_t(-1.0), float16_t(1.0), _518);
    _485.x *= float(min(_522, _511 * float16_t(_515)));
    _485.y /= float(max(_522, _511 * float16_t(_515)));
    float16_t _556 = (float16_t(dot(_485, _485)) * _503) + float16_t(1.0);
    float16_t _810 = max(_556, float16_t(0.0));
    float16_t _548 = _810;
    float16_t _558 = (_548 * _548) * (float16_t(3.0) - (float16_t(2.0) * _548));
    float16_t _571 = _558 - _507;
    float16_t _814 = max(_571, float16_t(0.0));
    _495 *= _814;

    // ========== 输入 ==========
    f16vec3 _575 = f16vec4(textureLod(_576, _489, 0.0)).xyz;  // 场景

    // ========================================================================
    // ★★★ 复古内胆: 2018 Tonemap0 逻辑 (替换 2026 ACES/Frostbite 段) ★★★
    // ========================================================================
    // 2018 参数解包
    mediump vec3 u_bloomTint   = _151._m0;          // 若为1.0则无 tint
    mediump vec4 u_bloomParams = _151._m3;
    mediump float u_exposure   = _151._m2;
    mediump vec2 u_viewportSize = vec2(1.0, 1.0);    // 纵横比从 _113._m4.x 已隐含

    // ① 反色调映射: 1/max(0.0001, x) - 1   (2018 复古核心, 产生高光过曝柔光)
    mediump vec3 ldr_8 = vec3(_575);
    highp vec3 inv = (1.0 / (max(vec3(0.0001, 0.0001, 0.0001), ldr_8))) - vec3(1.0, 1.0, 1.0);

    // ② motionBlur 混合 (2018: mix(inv, mb.xyz, mb.w))
    mediump vec4 mb = texture(_376, _489);
    highp vec3 fullComp = mix(inv, mb.xyz, mb.w);

    // ③ Bloom 合成 (2018 公式)
    highp vec3 comp = (((0.25 - (u_bloomParams.x * 0.25)) * fullComp)
                     + ((texture(_592, _489).xyz * u_bloomTint)
                        * (u_bloomParams.x + u_bloomParams.y))) * u_exposure;

    // ④ 屏幕暗角 (2018 公式, 复古电影感关键)
    highp vec2 deathOffset = _489 - vec2(0.5, 0.5);
    deathOffset.x *= _113._m4.x;                    // 纵横比
    lowp float vig = clamp(((dot(deathOffset, deathOffset) * 0.25) - 0.625) / -0.625, 0.0, 1.0);
    vig = max(((vig * (vig * (3.0 - (2.0 * vig)))) * 0.97) + 0.03 - 0.0625, 0.0);
    comp *= vig;

    // ⑤ Reinhard² 压缩 (2018 末段: (x/(x+0.25))²)
    highp vec3 s = comp + 0.25;
    highp vec3 out_col = (comp / s) * (comp / s);

    f16vec3 _822 = f16vec3(out_col);
    // ========================================================================
    // ★★★ 复古内胆结束 ★★★
    // ========================================================================

    // ========== 2026 外壳: 抖动 + 量化 (保留, 提升画质) ==========
    f16vec3 _823 = _822;
    f16vec3 _1123 = _823;
    _822 = _1123;
    f16vec3 _824 = _822;
    f16vec3 _1126 = _824;
    _822 = _1126;
    f16vec3 _825 = _822;
    float _1129 = _151._m3.x;
    float _1130 = _151._m3.y;
    float _1131 = dot(vec2(171.0, 231.0), gl_FragCoord.xy + vec2(_113._m20));
    vec3 _1132 = fract(vec3(_1131) / vec3(103.0, 71.0, 97.0)) - vec3(0.5);
    f16vec3 _1133 = _825 + f16vec3(_1132 * (((_1130 + _1129) >= 1.0099999904632568359375) ? 0.000977517105638980865478515625 : 0.0039215688593685626983642578125));
    _822 = _1133;
    f16vec3 _826 = _822;
    f16vec3 _680 = _826;
    _685 = vec4(f16vec4(_680, float16_t(1.0)));

    // 量化 (2026: RGB565 位掩码, 保留)
    if (_151._m6.z > 0)
    {
        uvec3 _697 = uvec3(uvec4(_685 * 65535.0).xyz);
        ivec2 _708 = textureSize(_709, 0);
        int _714 = _151._m6.w;
        vec2 _717 = vec2(_113._m0.xy / vec2(_708 * ivec2(_714)));
        f16vec4 _731 = f16vec4(texture(_709, _379 * _717));
        uvec3 _738 = mix(uvec3(0u), uvec3(65535u), bvec3(uint(float(_731.x) * 65535.0) > 0u));
        uvec3 _750 = _697;
        uvec3 _752 = _738;
        uint _1161 = (65535u << uint(_151._m6.y)) & 65535u;
        uint _1162 = (~_1161) & 65535u;
        uint _1163 = uint(_151._m6.x);
        if (_752.x == 0u)
            _750 |= uvec3(_1162 << _1163);
        else
            _750 &= uvec3(_1161 << _1163);
        _697 = _750;
        _685 = vec4(f16vec4(float16_t(float(float16_t(_697.x)) / 65535.0), float16_t(float(float16_t(_697.y)) / 65535.0), float16_t(float(float16_t(_697.z)) / 65535.0), float16_t(1.0)));
    }
}
