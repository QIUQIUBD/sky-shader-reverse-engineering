# Sky Shader Reverse Engineering Toolkit

Reverse engineering & analysis toolkit for **Sky: Children of the Light** legacy (2018) rendering pipeline.

> ⚠️ **Disclaimer**: This repository contains **research methodology, analysis notes and original tools** only.
> It does **NOT** contain copyrighted game assets, extracted binaries, or proprietary game data.
> All reverse engineering was performed for **educational / modding research purposes**.
> Use at your own risk. This project is not affiliated with or endorsed by thatgamecompany.

## What's inside

```
docs/                 Analysis reports & guides
  ├─ 14_render_shader_analysis.md       Render pipeline & shader analysis
  ├─ 15_android_replace_guide.md        Android shader replacement guide
  ├─ 16_intl_v0343_render_diff.md       International v0.34.3 render diff
  ├─ 17_vintage_port_guide.md           2018 → modern shader port guide
  ├─ 18_intl_shader_library.md          International shader library notes
  ├─ 19_lighting_evolution.md           Lighting evolution (2018 → present)
  └─ 20_frida_injection_live.md         Frida injection field notes

scripts/python/       Python analysis tools
  ├─ spirv_info.py          SPIR-V binary inspector
  ├─ luadump52.py           Lua 5.2 bytecode disassembler
  ├─ fnv_index.py           FNV-1a hash index helper
  ├─ gen_shader_index.py    Shader index generator
  ├─ gen_swap_lite.py       Lightweight shader swap generator
  ├─ gen_swap_trace.py      Swap trace generator
  └─ detect_android_shaders.py  Android shader detector

scripts/frida/        Frida instrumentation scripts
  ├─ hook_vkShaderModule.js   vkCreateShaderModule hook (SPIR-V replacement)
  ├─ dump_assets.js           Asset dump helper
  └─ diag*.js                 Render path diagnostics

glsl/                 Original GLSL written by this project
  ├─ vintage_tonemap_rec709.fs.glsl   2018 vintage tonemap (rec709) port
  └─ vintage_hardcoded.fs.glsl        Deterministic hardcoded-parameter version

data/                 Analysis output data (text)
  ├─ shader_declarations.txt
  ├─ shader_inventory.txt
  ├─ intl_common_2018.txt
  └─ intl_removed_2018.txt
```

## Key technique: runtime SPIR-V replacement

The core technique is intercepting `vkCreateShaderModule` on Android (Adreno),
identifying the target shader module by FNV-1a hash of its SPIR-V, then
overwriting `pCode` with a recompiled shader **without changing `codeSize`**
(SPIR-V parsers ignore trailing bytes; overriding `codeSize` itself can crash
the driver with SIGABRT).

```js
// hook_vkShaderModule.js — simplified core
const fp = fnv1a(pCode.readByteArray(codeSize));
if (fp === TARGET_HASH && replacementSpv) {
    pCode.writeByteArray(replacementSpv);   // keep codeSize unchanged!
}
```

Lessons learned (crash avoidance):
1. Match the **actually rendered** module (verify by FNV-1a at runtime),
   not the AAsset file — they differ.
2. Match the module's **SPIR-V version** (1.3 for rec709 on this driver).
   A 1.0 module with `Float16` capability is rejected by the Adreno driver.
3. **Never** override `codeSize` — the driver validates it; mismatch → SIGABRT.
4. Prefer shaders with **hardcoded parameters** to avoid UBO layout mismatches.

## Requirements

- Rooted Android device (tested: Xiaomi Mi 9, Adreno 640, Android 11)
- Frida server on device (`frida -H 127.0.0.1:27042`)
- glslangValidator / spirv-tools for shader compilation & validation

## License

MIT (unless noted). Research content provided as-is, for educational purposes.