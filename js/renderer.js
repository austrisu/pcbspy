/* renderer.js — WebGL renderer.
   Each layer is a unit quad (0..1) in source/texture space, pushed through its
   3x3 homography (uH: source -> world) and then the camera (uCam: world -> clip).

   Perspective-correct texture sampling for freeform (non-affine) layers:
   For a source point s we have world_h = uH * [s,1] (homogeneous). The affine
   camera keeps the last row (0,0,1), so clip_h = uCam * world_h has clip_h.z
   equal to world_h.z. We write gl_Position = (clip_h.x, clip_h.y, 0, clip_h.z),
   so the perspective divide reproduces the correct screen position AND the GPU's
   perspective-correct varying interpolation reconstructs the true source coord at
   every fragment. For affine layers world_h.z == 1, so w == 1 (ordinary case). */
(function (global) {
  'use strict';

  const VERT = `
    attribute vec2 aPos;          // unit-quad corner, also the texcoord (0..1)
    uniform mat3 uH;              // source -> world
    uniform mat3 uCam;            // world  -> clip (affine, last row 0 0 1)
    varying vec2 vTex;
    void main() {
      vec3 world = uH * vec3(aPos, 1.0);
      vec3 clip  = uCam * world;
      gl_Position = vec4(clip.x, clip.y, 0.0, clip.z);
      vTex = aPos;
    }`;

  const FRAG = `
    precision mediump float;
    uniform sampler2D uTex;
    uniform float uOpacity;
    uniform float uBrightness;   // 1 = unchanged
    uniform float uContrast;     // 1 = unchanged
    uniform float uSaturation;   // 1 = unchanged, 0 = grayscale
    uniform float uHue;          // radians, 0 = unchanged
    uniform float uSharpen;      // >0 sharpen, <0 soften (blur), 0 = unchanged
    uniform vec2  uTexel;        // 1/width, 1/height (texture space)
    varying vec2 vTex;

    vec3 hueRotate(vec3 col, float a) {
      const vec3 k = vec3(0.57735026919); // 1/sqrt(3), the gray axis
      float c = cos(a);
      return col * c + cross(k, col) * sin(a) + k * dot(k, col) * (1.0 - c);
    }

    void main() {
      vec4 c = texture2D(uTex, vTex);
      vec3 rgb = c.rgb;
      // Sharpen (positive) / soften (negative) via a 4-neighbour Laplacian kernel.
      if (uSharpen != 0.0) {
        vec3 sum =
            texture2D(uTex, vTex + vec2(uTexel.x, 0.0)).rgb +
            texture2D(uTex, vTex - vec2(uTexel.x, 0.0)).rgb +
            texture2D(uTex, vTex + vec2(0.0, uTexel.y)).rgb +
            texture2D(uTex, vTex - vec2(0.0, uTexel.y)).rgb;
        rgb = rgb * (1.0 + 4.0 * uSharpen) - sum * uSharpen;
      }
      rgb *= uBrightness;
      rgb = (rgb - 0.5) * uContrast + 0.5;
      float l = dot(rgb, vec3(0.299, 0.587, 0.114));
      rgb = mix(vec3(l), rgb, uSaturation);
      rgb = hueRotate(rgb, uHue);
      c.rgb = clamp(rgb, 0.0, 1.0);
      c.a *= uOpacity;
      gl_FragColor = c;
    }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  class Renderer {
    constructor(canvas) {
      const gl = canvas.getContext('webgl', {
        premultipliedAlpha: false,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: false,
      });
      if (!gl) throw new Error('WebGL is not available in this browser.');
      this.gl = gl;
      this.canvas = canvas;

      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
      }
      this.prog = prog;

      this.loc = {
        aPos: gl.getAttribLocation(prog, 'aPos'),
        uH: gl.getUniformLocation(prog, 'uH'),
        uCam: gl.getUniformLocation(prog, 'uCam'),
        uTex: gl.getUniformLocation(prog, 'uTex'),
        uOpacity: gl.getUniformLocation(prog, 'uOpacity'),
        uBrightness: gl.getUniformLocation(prog, 'uBrightness'),
        uContrast: gl.getUniformLocation(prog, 'uContrast'),
        uSaturation: gl.getUniformLocation(prog, 'uSaturation'),
        uHue: gl.getUniformLocation(prog, 'uHue'),
        uSharpen: gl.getUniformLocation(prog, 'uSharpen'),
        uTexel: gl.getUniformLocation(prog, 'uTexel'),
      };

      // Two triangles covering the unit square.
      const verts = new Float32Array([
        0, 0, 1, 0, 1, 1,
        0, 0, 1, 1, 0, 1,
      ]);
      this.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    }

    // Upload an ImageBitmap (or canvas/image) once, return a GPU texture.
    createTexture(source) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      // NPOT-safe sampling: clamp + linear, no mipmaps.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return tex;
    }

    deleteTexture(tex) {
      if (tex) this.gl.deleteTexture(tex);
    }

    // camMatrix: row-major world->clip. layers: array in draw order (bottom first).
    draw(camMatrix, layers) {
      const gl = this.gl;
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0.11, 0.12, 0.14, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(this.loc.aPos);
      gl.vertexAttribPointer(this.loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix3fv(this.loc.uCam, false, Mat3.toGL(camMatrix));
      gl.uniform1i(this.loc.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);

      for (const layer of layers) {
        if (!layer.visible || !layer.texture) continue;
        gl.bindTexture(gl.TEXTURE_2D, layer.texture);
        gl.uniformMatrix3fv(this.loc.uH, false, Mat3.toGL(layer.matrix));
        gl.uniform1f(this.loc.uOpacity, layer.opacity);
        gl.uniform1f(this.loc.uBrightness, layer.brightness != null ? layer.brightness : 1);
        gl.uniform1f(this.loc.uContrast, layer.contrast != null ? layer.contrast : 1);
        gl.uniform1f(this.loc.uSaturation, layer.saturation != null ? layer.saturation : 1);
        gl.uniform1f(this.loc.uHue, ((layer.hue != null ? layer.hue : 0) * Math.PI) / 180);
        // Map the -1..1 slider to a kernel amount: gentle on the soften side
        // (down to a full 4-neighbour average) and stronger on the sharpen side.
        const s = layer.sharpen != null ? layer.sharpen : 0;
        gl.uniform1f(this.loc.uSharpen, s >= 0 ? s * 1.0 : s * 0.25);
        gl.uniform2f(this.loc.uTexel, 1 / (layer.w || 1), 1 / (layer.h || 1));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }
  }

  global.Renderer = Renderer;
})(window);
