// Turns a visual into glyphs on the GPU.
//   pass 1  the visual's field() renders to a texture with one texel per braille dot
//   pass 2  particle sims (if any) draw additively into that texture
//   pass 3  the glyph shader quantizes it into cells: braille, ASCII, lines, dots, grain or blocks
import { VISUALS, visualDef } from './library.js';

const VS = `#version 300 es
in vec2 a;out vec2 vUV;void main(){vUV=a*.5+.5;gl_Position=vec4(a,0.,1.);}`;

const FIELD_HEAD = `#version 300 es
precision highp float;
in vec2 vUV;out vec4 O;
uniform float uT,uB,uKick,uE,uAspect,uMaxDiv,uTime,uZoom;
uniform vec2 uRes;
uniform sampler2D uPrev;
#define TAU 6.2831853
float sat(float x){return clamp(x,0.,1.);}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float hash(float n){return fract(sin(n*12.9898+4.1)*43758.5453);}
float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
vec2 hash2(vec2 p){vec3 q=fract(vec3(p.xyx)*vec3(.1031,.103,.0973));q+=dot(q,q.yzx+33.33);return fract((q.xx+q.yz)*q.zy);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float z=i.z*17.;
  float a=mix(mix(hash(i.xy+z),hash(i.xy+vec2(1,0)+z),f.x),mix(hash(i.xy+vec2(0,1)+z),hash(i.xy+vec2(1,1)+z),f.x),f.y);
  z+=17.;
  float b=mix(mix(hash(i.xy+z),hash(i.xy+vec2(1,0)+z),f.x),mix(hash(i.xy+vec2(0,1)+z),hash(i.xy+vec2(1,1)+z),f.x),f.y);
  return mix(a,b,f.z);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=rot(.6)*2.02;for(int i=0;i<5;i++){v+=a*noise(p);p=m*p+7.;a*=.5;}return v;}
float fbm3(vec3 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise3(p);p=p*2.03+7.;a*=.5;}return v;}
vec2 curl(vec2 p,float t){const float e=.03;
  float a=noise3(vec3(p+vec2(0,e),t))+.5*noise3(vec3(p*2.+vec2(0,e),t)),b=noise3(vec3(p-vec2(0,e),t))+.5*noise3(vec3(p*2.-vec2(0,e),t));
  float c=noise3(vec3(p+vec2(e,0),t))+.5*noise3(vec3(p*2.+vec2(e,0),t)),d=noise3(vec3(p-vec2(e,0),t))+.5*noise3(vec3(p*2.-vec2(e,0),t));
  return vec2(a-b,d-c)/(2.*e);}
vec2 prev(vec2 uv){vec4 s=textureLod(uPrev,uv,0.);return vec2(s.r,s.g/max(s.r,1e-4));}
float stepOf(float d){return floor(uB*min(d,uMaxDiv));}
float phaseOf(float d){return fract(uB*min(d,uMaxDiv));}
`;
const FIELD_MAIN = `
uniform float uScale;
void main(){vec2 p=(vUV-.5)*vec2(uAspect,1.)*2./uScale;vec2 r=field(vUV,p);r.x=max(r.x,0.);O=vec4(r.x,r.x*r.y,0.,1.);}`;

const SIM_VS = `#version 300 es
in vec4 a;uniform vec2 uK;uniform float uPS;out vec2 v;
void main(){v=a.zw;gl_Position=vec4(a.xy*uK,0.,1.);gl_PointSize=uPS;}`;
const SIM_FS = `#version 300 es
precision highp float;in vec2 v;out vec4 O;void main(){O=vec4(v.x,v.x*v.y,0.,1.);}`;

const ASCII_RAMP = " .,:;~=+*oxO#%@";

const GLYPH_FS = `#version 300 es
precision highp float;
in vec2 vUV;out vec4 O;
uniform vec4 uRegion;
vec2 P;
uniform sampler2D uF,uF2,uRamp,uAtlas;
uniform vec2 uView,uCells,uDots;
uniform int uStyle,uMixType;
uniform float uMix,uRow,uRow2,uGlow,uGain,uFlash;
uniform vec3 uFlashC;
const float N=${ASCII_RAMP.length}.;
float sat(float x){return clamp(x,0.,1.);}
float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
vec3 ramp(float c,float row){return texture(uRamp,vec2(sat(c)*.992+.004,row)).rgb;}
// intensity and colour at uv, with the running transition applied (uF is the incoming visual)
vec3 samp(vec2 uv,float lod){
  vec4 a=textureLod(uF,uv,lod);
  if(uMixType==0)return vec3(a.r,a.g/max(a.r,1e-3),uRow);
  vec4 b=textureLod(uF2,uv,lod);
  float m=uMix,x=0.;
  if(uMixType==2)m=sat((uMix*1.25-uv.x)/.25);
  if(uMixType==3)m=sat((uMix*1.25-length(uv-.5)/.72)/.25);
  if(uMixType==4){m=step(.5,uMix);x=pow(1.-abs(2.*uMix-1.),2.);}
  if(uMixType==5){float d=abs(2.*uMix-1.);m=step(.5,uMix);a*=d;b*=d;}
  vec4 c=mix(b,a,m);
  return vec3(max(c.r,x),c.g/max(c.r,1e-3),m>.5?uRow:uRow2);
}
vec3 braille(){
  vec2 cf=P*uCells,cell=floor(cf),dp=fract(cf)*vec2(2.,4.),di=floor(dp),dl=fract(dp)-.5;
  dl.x+=di.x<.5?-.08:.08;
  vec2 tx=cell*vec2(2.,4.)+di;
  vec3 s=samp((tx+.5)/uDots,0.);
  float v=sat(s.x);
  vec2 ds=uView/uDots;
  float r=min(ds.x,ds.y)*.37;
  float a=step(ign(tx+.5)*.94+.03,v)*smoothstep(r+.7,r-.7,length(dl*ds));
  vec3 cs=samp((cell+.5)/uCells,1.5);
  vec3 col=ramp(cs.x>.01?cs.y:s.y,s.z);
  col=mix(col,vec3(1.),smoothstep(.85,1.25,s.x)*.55);
  return col*a*(.62+.38*v);
}
vec3 ascii(){
  vec2 cf=P*uCells,cell=floor(cf),f=fract(cf);
  vec3 s=samp((cell+.5)/uCells,1.5);
  float v=sat(s.x);
  float idx=floor(pow(v,.72)*(N-.001));
  float a=texture(uAtlas,(vec2(idx,0.)+vec2(f.x,1.-f.y))/vec2(N,1.)).r;
  return ramp(s.y,s.z)*a*(.65+.35*v);
}
vec3 lines(){
  vec2 cf=P*uCells,cell=floor(cf),f=fract(cf),c=(cell+.5)/uCells,e=1./uCells;
  vec3 s=samp(c,1.5);
  float v=sat(s.x);
  float gx=samp(c+vec2(e.x,0.),1.5).x-samp(c-vec2(e.x,0.),1.5).x;
  float gy=samp(c+vec2(0.,e.y),1.5).x-samp(c-vec2(0.,e.y),1.5).x;
  float ang=floor((atan(gy,gx)+1.5708)/.7854+.5)*.7854;
  vec2 q=(f-.5)*vec2(1.,2.);
  float cs=cos(ang),sn=sin(ang);
  q=vec2(cs*q.x+sn*q.y,-sn*q.x+cs*q.y);
  float aa=2./(uView.x/uCells.x);
  float w=.05+.12*v;
  float a=smoothstep(w+aa,w-aa,abs(q.y))*smoothstep(.62+aa,.62-aa,abs(q.x))*step(.06,v);
  return ramp(s.y,s.z)*a*(.6+.4*v);
}
vec3 dots(){
  vec2 cf=P*uCells,cell=floor(cf),f=fract(cf);
  vec3 s=samp((cell+.5)/uCells,1.);
  float v=sat(s.x);
  float aa=1.5/(uView.x/uCells.x);
  float r=.52*sqrt(v);
  float a=smoothstep(r+aa,r-aa,length(f-.5))*step(.015,v);
  return ramp(s.y,s.z)*a;
}
vec3 grain(){
  float px=max(1.,floor(uView.x/(uCells.x*4.)));
  vec2 g=floor(gl_FragCoord.xy/px);
  vec3 s=samp(P,0.);
  float a=step(hash(g)*.96+.02,sat(s.x));
  vec3 col=ramp(s.y,s.z);
  return mix(col,vec3(1.),smoothstep(.45,1.,s.x)*.75)*a;
}
vec3 blocks(){
  vec2 cf=P*uCells,cell=floor(cf),f=fract(cf);
  vec3 s=samp((cell+.5)/uCells,1.);
  float v=floor(sat(s.x)*4.999)/4.;
  vec2 g=1./(uView/uCells);
  float a=step(g.x,f.x)*step(g.y,f.y);
  return ramp(s.y,s.z)*v*a;
}
void main(){
  P=uRegion.xy+vUV*uRegion.zw;
  vec3 c;
  if(uStyle==0)c=braille();else if(uStyle==1)c=ascii();else if(uStyle==2)c=lines();
  else if(uStyle==3)c=dots();else if(uStyle==4)c=grain();else c=blocks();
  if(uGlow>0.){vec3 g=samp(P,3.5);c+=ramp(g.y,g.z)*sat(g.x)*uGlow*.42;}
  c*=uGain;
  c=mix(c,uFlashC,uFlash);
  O=vec4(c,1.);
}`;

const STYLE_IDS = { braille: 0, ascii: 1, lines: 2, dots: 3, grain: 4, blocks: 5 };
const COLOR_ROWS = { palette: 0, mono: 1, thermal: 2, ice: 3 };
const MIX_IDS = { fade: 1, wipe: 2, iris: 3, flash: 4, dip: 5 };
const FIXED_RAMPS = {
  mono: ['#8d8d8d', '#d0d0d0', '#ffffff'],
  thermal: ['#2a3fd0', '#19c3d6', '#f4d35e', '#f2542d', '#e0127b'],
  ice: ['#1d3f9e', '#3f86ea', '#a6d4ff', '#ffffff'],
};

/** Each visual starts somewhere different, the same place on every screen. */
function seedOf(id) {
  let n = 7;
  for (let i = 0; i < id.length; i++) n = (Math.imul(n, 31) + id.charCodeAt(i)) >>> 0;
  return n % 400;
}

function hexRgb(h) {
  const n = parseInt((h || '#ffffff').slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** How fast a visual moves, per beat, before the live energy fader. */
export const motionRate = (vis) => vis.speed * (0.55 + 0.9 * vis.energy);

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    this.gl = gl;
    if (!gl) return;
    this.float = !!gl.getExtension('EXT_color_buffer_float');
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.programs = new Map();
    this.queue = VISUALS.map((v) => v.id);
    this.instances = new Map();

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.quad = gl.createVertexArray();
    gl.bindVertexArray(this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.glyph = this._link(VS, GLYPH_FS, true);
    this.simProg = this._link(SIM_VS, SIM_FS, true);

    this.ramp = gl.createTexture();
    this.setPalette(['#ffffff']);
    this.atlas = gl.createTexture();
    this._buildAtlas();
    document.fonts?.load('500 40px "JetBrains Mono"').then(() => this._buildAtlas());

    this.blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    gl.disable(gl.DEPTH_TEST);
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => location.reload());
  }

  // ---------------------------------------------------------------- programs
  _link(vs, fs, block) {
    const gl = this.gl;
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'a');
    gl.linkProgram(p);
    const entry = { p, v, f, ready: false, failed: false, u: {} };
    if (block) this._finish(entry);
    return entry;
  }

  _finish(e) {
    const gl = this.gl;
    if (!gl.getProgramParameter(e.p, gl.LINK_STATUS)) {
      console.error(gl.getShaderInfoLog(e.f) || gl.getProgramInfoLog(e.p));
      e.failed = true;
      return;
    }
    const n = gl.getProgramParameter(e.p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(e.p, i).name;
      e.u[name] = gl.getUniformLocation(e.p, name);
    }
    gl.deleteShader(e.v); gl.deleteShader(e.f);
    e.ready = true;
  }

  /** Shaders compile in the background, a few per frame, so nothing hitches mid-set. */
  pump() {
    if (!this.gl) return;
    if (this.queue.length) {
      const pending = [...this.programs.values()].filter((e) => !e.ready && !e.failed).length;
      if (pending < 3) this._program(this.queue.shift());
    }
    for (const e of this.programs.values()) {
      if (e.ready || e.failed) continue;
      if (!this.parallel || this.gl.getProgramParameter(e.p, this.parallel.COMPLETION_STATUS_KHR)) this._finish(e);
    }
  }

  _program(id) {
    let e = this.programs.get(id);
    if (e) return e;
    const def = visualDef(id);
    if (!def) return null;
    e = this._link(VS, FIELD_HEAD + def.glsl + FIELD_MAIN, false);
    this.programs.set(id, e);
    this.queue = this.queue.filter((q) => q !== id);
    return e;
  }

  isReady(id) {
    if (id === 'none') return true;
    const e = this._program(id);
    return !!e && e.ready;
  }

  // ---------------------------------------------------------------- textures
  setPalette(colors) {
    const gl = this.gl;
    if (!gl) return;
    const key = colors.join();
    if (key === this._palKey) return;
    this._palKey = key;
    const W = 256, rows = [colors, FIXED_RAMPS.mono, FIXED_RAMPS.thermal, FIXED_RAMPS.ice];
    const px = new Uint8Array(W * rows.length * 4);
    rows.forEach((list, r) => {
      const cs = list.map(hexRgb);
      for (let x = 0; x < W; x++) {
        const t = (x / (W - 1)) * (cs.length - 1), i = Math.min(cs.length - 2, Math.floor(t)), f = t - i;
        const a = cs[Math.max(i, 0)], b = cs[Math.min(i + 1, cs.length - 1)];
        for (let k = 0; k < 3; k++) px[(r * W + x) * 4 + k] = a[k] + (b[k] - a[k]) * f;
        px[(r * W + x) * 4 + 3] = 255;
      }
    });
    gl.bindTexture(gl.TEXTURE_2D, this.ramp);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, rows.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.rampRows = rows.length;
  }

  _buildAtlas() {
    const gl = this.gl;
    const cw = 28, ch = 56, N = ASCII_RAMP.length;
    const c = document.createElement('canvas');
    c.width = cw * N; c.height = ch;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff';
    x.font = `500 ${ch * 0.78}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let i = 0; i < N; i++) x.fillText(ASCII_RAMP[i], (i + 0.5) * cw, ch * 0.52);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _target(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, this.float ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }

  // ---------------------------------------------------------------- instances
  _instance(id, slot) {
    const key = `${slot}:${id}`;
    let s = this.instances.get(key);
    if (!s) {
      s = { def: visualDef(id), T: null, lastBeat: null, targets: null, stamp: -1, sim: null, simBuf: null, simVao: null, simUnits: 1, thumb: slot === 'thumb' };
      this.instances.set(key, s);
    }
    return s;
  }

  _size(s, w, h) {
    if (s.targets && s.targets[0].w === w && s.targets[0].h === h) return;
    const gl = this.gl;
    for (const t of s.targets || []) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    s.targets = [this._target(w, h), this._target(w, h)];
  }

  /** Advance a visual one frame. Returns its field texture, or null if not compiled yet. */
  _advance(id, vis, f, slot, dotsW, dotsH, aspect, units = 1) {
    const e = this._program(id);
    if (!e?.ready) return null;
    const gl = this.gl;
    const s = this._instance(id, slot);
    this._size(s, dotsW, dotsH);
    if (s.stamp === f.stamp) return s.targets[0];
    s.stamp = f.stamp;

    let dB = s.lastBeat == null ? 0 : f.beat - s.lastBeat;
    s.lastBeat = f.beat;
    if (!(dB > 0)) dB = 0;
    dB = Math.min(dB, 0.25);
    const E = Math.max(0, Math.min(1, vis.energy + f.energy - 0.5));
    // motion time comes only from the shared beat, so separate screens stay in step
    const T = seedOf(id) + (vis.t0 || 0) + motionRate(vis) * f.beat + 0.9 * vis.speed * (f.phase || 0);
    const dT = s.T == null ? 0 : Math.min(0.5, Math.max(0, T - s.T));
    s.T = T;

    const [front, back] = s.targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, back.fbo);
    gl.viewport(0, 0, back.w, back.h);
    gl.disable(gl.BLEND);
    gl.useProgram(e.p);
    const u = e.u;
    gl.uniform1f(u.uT, s.T);
    gl.uniform1f(u.uB, f.beat);
    gl.uniform1f(u.uKick, f.kick);
    gl.uniform1f(u.uE, E);
    // a picture wider than one TV zooms in, so its composition fills the whole group
    const zoom = s.def.fill === false ? 1 : Math.max(1, aspect / (16 / 9));
    gl.uniform1f(u.uScale, vis.scale * zoom);
    gl.uniform1f(u.uZoom, zoom);
    gl.uniform1f(u.uAspect, aspect);
    gl.uniform1f(u.uMaxDiv, f.maxDiv);
    gl.uniform1f(u.uTime, f.time);
    gl.uniform2f(u.uRes, back.w, back.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, front.tex);
    gl.uniform1i(u.uPrev, 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (s.def.sim) {
      // sims were tuned at 320 x 180 dots; thin them out when there are fewer dots to land on
      const density = Math.min(1, (back.w * back.h) / (s.thumb ? 0.18 * 57600 : 57600 * units));
      this._runSim(s, { T: s.T, dT, dB, kick: f.kick, E, aspect, scale: vis.scale * zoom, density }, units);
    }

    gl.bindTexture(gl.TEXTURE_2D, back.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    s.targets = [back, front];
    return back;
  }

  _runSim(s, u, units = 1) {
    const gl = this.gl;
    if (!s.sim || s.simUnits !== units) {
      // a wider picture gets proportionally more particles
      s.sim = s.def.sim(s.thumb, units);
      s.simUnits = units;
      if (s.simBuf) { gl.deleteBuffer(s.simBuf); gl.deleteVertexArray(s.simVao); }
      s.simBuf = gl.createBuffer();
      s.simVao = gl.createVertexArray();
      gl.bindVertexArray(s.simVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.simBuf);
      gl.bufferData(gl.ARRAY_BUFFER, s.sim.data.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    }
    s.sim.update(u);
    gl.bindVertexArray(s.simVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.simBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.sim.data);
    gl.useProgram(this.simProg.p);
    gl.uniform2f(this.simProg.u.uK, u.scale / u.aspect, u.scale);
    gl.uniform1f(this.simProg.u.uPS, s.def.simPoint || 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(s.sim.prim === 'lines' ? gl.LINES : gl.POINTS, 0, s.sim.count);
    gl.disable(gl.BLEND);
  }

  // ---------------------------------------------------------------- output
  fit(w, h) {
    if (this.canvas.width < w) this.canvas.width = w;
    if (this.canvas.height < h) this.canvas.height = h;
  }

  /**
   * Draw one frame into the bottom-left w x h of the canvas.
   * opts: { vis, from, mix, mixType, frame, gain, flash, flashColor, slot, aspect, colsScale, region }
   * For a group of TVs, aspect and colsScale describe the whole picture and region picks the part to draw.
   */
  draw(w, h, opts) {
    const gl = this.gl;
    if (!gl) return false;
    const { vis, from, mix = 0, mixType = 'fade', frame, gain = 1, flash = 0, flashColor = '#ffffff', slot = 'main', colsScale = 1, region = [0, 0, 1, 1] } = opts;
    const aspect = opts.aspect ?? w / h;
    const cols = Math.min(960, Math.round(vis.cols * colsScale));
    const rows = Math.max(4, Math.round(cols / aspect / 2));
    const dotsW = cols * 2, dotsH = rows * 4;

    const live = vis.id === 'none' ? null : this._advance(vis.id, vis, frame, slot, dotsW, dotsH, aspect, colsScale);
    if (vis.id !== 'none' && !live) return false;
    const old = from && from.id !== 'none' ? this._advance(from.id, from, frame, slot, dotsW, dotsH, aspect, colsScale) : null;

    const g = this.glyph;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(g.p);
    const u = g.u;
    const square = vis.style === 'dots' || vis.style === 'blocks';
    gl.uniform2f(u.uView, w / region[2], h / region[3]);
    gl.uniform4f(u.uRegion, region[0], region[1], region[2], region[3]);
    gl.uniform2f(u.uCells, cols, square ? rows * 2 : rows);
    gl.uniform2f(u.uDots, dotsW, dotsH);
    gl.uniform1i(u.uStyle, STYLE_IDS[vis.style] ?? 0);
    const row = (c) => ((COLOR_ROWS[c] ?? 0) + 0.5) / this.rampRows;
    gl.uniform1f(u.uRow, row(vis.color));
    gl.uniform1f(u.uRow2, row(from?.color ?? vis.color));
    gl.uniform1i(u.uMixType, from ? MIX_IDS[mixType] ?? 1 : 0);
    gl.uniform1f(u.uMix, mix);
    gl.uniform1f(u.uGlow, vis.glow);
    gl.uniform1f(u.uGain, gain);
    gl.uniform1f(u.uFlash, flash);
    const fc = hexRgb(flashColor);
    gl.uniform3f(u.uFlashC, fc[0] / 255, fc[1] / 255, fc[2] / 255);
    const bind = (unit, tex, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); };
    bind(0, live ? live.tex : this.blank, u.uF);
    bind(1, old ? old.tex : this.blank, u.uF2);
    bind(2, this.ramp, u.uRamp);
    bind(3, this.atlas, u.uAtlas);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
}
