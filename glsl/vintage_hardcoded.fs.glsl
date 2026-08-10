#version 450
// vintage_hardcoded.fs.glsl — 2018复古调色硬编码版
// 不依赖游戏 UBO 运行时数据, 固定参数输出确定性复古效果
// 输入: _color(binding0) + _bloom(binding3, 可选) + uv(location0)
// 输出: 暖橙色调 + 暗角 + 柔光 (2018 Sky 标志性风格)

layout(location = 0) in vec2 v_uv;

// 主颜色输入 (binding0): 只需 _m0.rgb
layout(set = 1, binding = 0, std140) uniform _149_151 {
    vec3 _m0;      // color.rgb
    float _m1;     // unused
    float _m2;     // unused
    vec4 _m3;      // unused
    float _m4;     // unused
    float _m5;     // unused
    ivec4 _m6;     // unused
} _151;

// 辉光输入 (binding3): 可选
layout(set = 1, binding = 3) uniform sampler2D _576;

layout(location = 0) out vec4 _685;

void main() {
    // --- 读取输入 ---
    vec3 color = _151._m0.rgb;
    float bloomSample = texture(_576, v_uv).r;

    // --- 2018 复古风格参数 (硬编码) ---
    // 曝光 (2018年参数较大)
    float exposure = 1.45;

    // 暖橙色调 (2018年色温偏暖)
    vec3 warmTint = vec3(1.06, 0.97, 0.88);

    // 暗角 (按屏幕距离)
    vec2 dist = v_uv - vec2(0.5);
    float vignette = 1.0 - dot(dist, dist) * 1.1;
    vignette = clamp(vignette, 0.0, 1.0);
    vignette = smoothstep(0.0, 1.0, vignette);

    // 柔光 (基于亮度提亮, 2018年辉光较强)
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    float softGlow = bloomSample * 0.9 + lum * 0.35;

    // --- 合成 ---
    vec3 outColor = color * exposure;
    outColor *= warmTint;
    outColor += softGlow * vec3(0.55, 0.42, 0.30);
    outColor *= vignette;

    // 轻微 gamma 校正 (近似2018输出)
    outColor = pow(max(outColor, vec3(0.0)), vec3(0.95));

    _685 = vec4(outColor, 1.0);
}
