// Physically based light renderer for the stage. Everything is computed in linear, high dynamic
// range light and only turned into screen colours at the very end, the way a camera would see it.
//
//   surface light   what lands on the wall and floor: inverse-square falloff, beam washes, floor pools
//   air light       what the haze scatters toward you: beam shafts and halos, broken up by drifting smoke
//   emission        the sources themselves: LED chips, glass bulbs, filaments, flood lenses, the TV picture
//   composite       room colour x surface light + air + emission + floor reflection
//   bloom, film     lens glow, then a filmic curve, so hot sources clip toward white and keep a coloured halo
//
// Stage space: x runs 0..aspect, y runs 0..1 downward, so one unit is the stage's height.

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 q;out vec2 vUV;
void main(){vUV=q*.5+.5;gl_Position=vec4(q,0.,1.);}`;

const HEAD = `#version 300 es
precision highp float;
`;
const CLIP = `uniform float uAspect;
vec4 clip(vec2 w){return vec4(w.x/uAspect*2.-1.,1.-w.y*2.,0.,1.);}
`;

// ---- instanced point lights: LEDs, string bulbs, hanging bulbs, TV spill
const POINT_ATTRS = `
layout(location=0) in vec2 q;
layout(location=1) in vec2 iP;
layout(location=2) in vec3 iC;
layout(location=3) in vec4 iA; // power, height off the wall, core radius, kind
uniform sampler2D uTV;
vec3 lightColor(){return iA.w>3.5?pow(textureLod(uTV,iC.xy,2.5).rgb,vec3(2.2)):iC;}
`;
const SURFACE_POINT_VS = HEAD + CLIP + POINT_ATTRS + `
out vec2 vD;out vec3 vC;out vec3 vA;out float vY;
void main(){
  float h=iA.y,R=clamp(h*8.,.05,2.6);
  vec2 w=iP+q*R;
  vD=q*R;vC=lightColor();vA=vec3(iA.x,h,R);vY=w.y;
  gl_Position=clip(w);
}`;
const SURFACE_POINT_FS = HEAD + `
in vec2 vD;in vec3 vC;in vec3 vA;in float vY;out vec4 O;uniform float uFloor;
void main(){
  if(vY>uFloor)discard;
  float d2=dot(vD,vD),h=vA.y;
  float e=vA.x*h*pow(d2+h*h,-1.5)*smoothstep(1.,.45,sqrt(d2)/vA.z);
  O=vec4(vC*e,1.);
}`;
const AIR_POINT_VS = HEAD + CLIP + POINT_ATTRS + `
out vec2 vD;out vec3 vC;out vec2 vA;out vec2 vW;
void main(){
  float H=max(iA.y*1.6,.02)+iA.z*5.;
  vec2 w=iP+q*H;
  vD=q*H;vC=lightColor()*sqrt(iA.x);vA=vec2(H,iA.z+.004);vW=w;
  gl_Position=clip(w);
}`;
const AIR_POINT_FS = HEAD + `
in vec2 vD;in vec3 vC;in vec2 vA;in vec2 vW;out vec4 O;
uniform sampler2D uFog;uniform float uT,uHaze;
void main(){
  float d=length(vD),a=vA.y*vA.y*2.5;
  float v=a/(a+d*d)*smoothstep(1.,.15,d/vA.x);
  float f=texture(uFog,vW*.9+vec2(uT*.012,uT*.007)).r*1.8;
  O=vec4(vC*v*uHaze*mix(1.,f,.55),1.);
}`;
const EMIT_POINT_VS = HEAD + CLIP + POINT_ATTRS + `
uniform float uPx;
out vec2 vQ;out vec3 vC;out float vK;
void main(){
  float R=max(iA.z,uPx*1.25);
  vQ=q;vC=iC;vK=iA.w;
  gl_Position=iA.w>3.5?vec4(2.,2.,2.,1.):clip(iP+q*R);
}`;
const EMIT_POINT_FS = HEAD + `
in vec2 vQ;in vec3 vC;in float vK;out vec4 O;
void main(){
  float d=length(vQ);
  vec3 c;
  if(vK<.5){c=vC*3.6*smoothstep(1.,.45,d);}                                                  // LED chip
  else if(vK<1.5){c=vC*(.9+3.*exp(-d*d*6.))*smoothstep(1.,.82,d);}                           // small glass bulb
  else if(vK<2.5){c=vC*(1.5+3.5*exp(-d*d*3.))*smoothstep(1.,.88,d);}                         // frosted LED bulb
  else{                                                                                      // clear filament bulb
    float fil=exp(-(vQ.x*vQ.x*34.+vQ.y*vQ.y*7.))*(.65+.35*cos(vQ.x*38.));
    c=vC*(.35+.5*exp(-d*d*2.)+16.*fil)*smoothstep(1.,.88,d);
  }
  O=vec4(c,1.);
}`;

// ---- instanced floods: a cone from the lens
const FLOOD_ATTRS = `
layout(location=0) in vec2 q;
layout(location=1) in vec2 iP; // apex, just behind the lens
layout(location=2) in vec3 iC;
layout(location=3) in vec4 iA; // power, angle, half spread, length
layout(location=4) in vec3 iB; // apex to lens, seed, lens half width
`;
const FLOOD_QUAD = `
out vec2 vL;out vec3 vC;out vec4 vA;out vec3 vB;out vec2 vW;
void floodQuad(float grow){
  float a=iA.y,s=iA.z,L=iA.w;
  vec2 d=vec2(cos(a),sin(a)),n=vec2(-d.y,d.x);
  float W=(L*grow)*tan(s)*1.2+.02;
  vec2 l=vec2((q.x*.5+.5)*L*grow,q.y*W);
  vec2 w=iP+d*l.x+n*l.y;
  vL=l;vC=iC;vA=iA;vB=iB;vW=w;
  gl_Position=clip(w);
}
`;
const SURFACE_FLOOD_VS = HEAD + CLIP + FLOOD_ATTRS + FLOOD_QUAD + `void main(){floodQuad(1.);}`;
const SURFACE_FLOOD_FS = HEAD + `
in vec2 vL;in vec3 vC;in vec4 vA;in vec3 vB;in vec2 vW;out vec4 O;uniform float uFloor;
void main(){
  if(vW.y>uFloor)discard;
  float r=length(vL)+.001,ang=abs(atan(vL.y,vL.x));
  float cone=smoothstep(vA.z,vA.z*.5,ang);
  float fall=1./(1.+r*r/.09);
  O=vec4(vC*vA.x*cone*fall*smoothstep(vA.w,vA.w*.6,r),1.);
}`;
const AIR_FLOOD_VS = SURFACE_FLOOD_VS;
const AIR_FLOOD_FS = HEAD + `
in vec2 vL;in vec3 vC;in vec4 vA;in vec3 vB;in vec2 vW;out vec4 O;
uniform sampler2D uFog;uniform float uT,uHaze;
void main(){
  float r=length(vL)+.001,ang=atan(vL.y,vL.x)/vA.z;
  float cone=smoothstep(1.,.5,abs(ang)),core=exp(-ang*ang*4.5);
  float along=1./(1.+r*r*7.)*smoothstep(vA.w,vA.w*.55,r)*smoothstep(vB.x*.9,vB.x*1.25,vL.x);
  float f=texture(uFog,vW*.8+vec2(uT*.012,uT*.007)).r*1.8;
  f*=texture(uFog,vW*2.1-vec2(uT*.02,uT*.004)).r*1.8;
  float streak=.6+.8*texture(uFog,vec2(ang*.4+vB.y,r*.05-uT*.005)).g;
  O=vec4(vC*vA.x*uHaze*.62*(cone*.35+core*.65)*along*mix(1.,f,.75)*streak,1.);
}`;
const EMIT_LENS_VS = HEAD + CLIP + FLOOD_ATTRS + `
uniform float uPx;
out vec2 vQ;out vec3 vC;
void main(){
  float a=iA.y;
  vec2 d=vec2(cos(a),sin(a)),n=vec2(-d.y,d.x);
  float t=max(iB.z*.3,uPx*1.3);
  vQ=q;vC=iC;
  gl_Position=clip(iP+d*iB.x+d*q.x*t+n*q.y*iB.z);
}`;
const EMIT_LENS_FS = HEAD + `
in vec2 vQ;in vec3 vC;out vec4 O;
void main(){
  float a=smoothstep(1.,.5,abs(vQ.x))*smoothstep(1.,.86,abs(vQ.y));
  float hot=exp(-vQ.y*vQ.y*1.6);
  O=vec4(vC*(6.+16.*hot)*a,1.);
}`;

// ---- floor pools where a beam lands
const POOL_VS = HEAD + CLIP + `
layout(location=0) in vec2 q;
layout(location=1) in vec2 iP;
layout(location=2) in vec3 iC;
layout(location=3) in vec3 iA; // power, radius x, radius y
out vec2 vQ;out vec3 vC;out float vP;out float vY;
void main(){
  vec2 w=iP+q*iA.yz*2.4;
  vQ=q*2.4;vC=iC;vP=iA.x;vY=w.y;
  gl_Position=clip(w);
}`;
const POOL_FS = HEAD + `
in vec2 vQ;in vec3 vC;in float vP;in float vY;out vec4 O;uniform float uFloor;
void main(){
  if(vY<uFloor)discard;
  float d=dot(vQ,vQ);
  O=vec4(vC*vP*exp(-d)*smoothstep(5.76,3.,d),1.);
}`;

// ---- the TV picture
const SCREEN_VS = HEAD + CLIP + `
layout(location=0) in vec2 q;uniform vec4 uRect,uRegion;out vec2 vUV;
void main(){vUV=uRegion.xy+(q*.5+.5)*uRegion.zw;vec2 w=uRect.xy+vec2(q.x,-q.y)*uRect.zw;gl_Position=clip(w);}`;
const SCREEN_FS = HEAD + `
in vec2 vUV;out vec4 O;uniform sampler2D uTV;
void main(){O=vec4(pow(texture(uTV,vUV).rgb,vec3(2.2))*1.5,1.);}`;

// ---- room + light
const COMPOSITE_FS = HEAD + `
in vec2 vUV;out vec4 O;
uniform sampler2D uSurface,uAir,uEmit,uFixtures,uFog;
uniform float uAspect,uFloor,uAmbient,uHaze,uT;
uniform vec3 uGlow;
void main(){
  vec2 w=vec2(vUV.x*uAspect,1.-vUV.y);
  float fd=uFloor<2.&&w.y>uFloor?(w.y-uFloor)/(1.-uFloor):-1.;
  vec3 room;
  float ao=1.;
  if(uFloor<2.){
    ao=1.-.6*exp(-abs(w.y-uFloor)*30.);
    if(fd>=0.){
      // polished concrete, seen in perspective
      vec2 f=vec2((w.x-uAspect*.5)/(fd+.14),1./(fd+.14))*.2;
      float c=texture(uFog,f).r;
      room=vec3(.06,.058,.055)*(.65+.7*c);
    }else{
      // painted plaster
      float n=texture(uFog,w*1.3).r,n2=texture(uFog,w*5.7).g;
      room=vec3(.2,.195,.185)*(.8+.3*n+.14*n2);
    }
  }else room=vec3(.2);
  vec4 fx=texture(uFixtures,vUV);
  vec3 alb=mix(room,pow(fx.rgb,vec3(2.2)),fx.a);

  vec3 E=texture(uSurface,vUV).rgb;
  vec3 refl=vec3(0.);
  if(fd>=0.){
    vec2 m=vec2(vUV.x,1.-(uFloor-(w.y-uFloor)*.85));
    E+=textureLod(uSurface,m,0.).rgb*(.55-.3*fd);
    // the floor mirrors what's above it, blurring as it gets closer to the viewer
    float wob=(texture(uFog,w*vec2(3.,16.)).g-.5)*.012*fd;
    float rough=1.2+fd*4.5;
    for(float k=0.;k<4.;k++){
      vec2 s=vec2(m.x+wob,m.y+(k-1.5)*(.006+fd*.02));
      refl+=textureLod(uEmit,s,rough).rgb+textureLod(uAir,s,rough*.6).rgb*.6;
    }
    refl*=.25*(.04+.5*pow(1.-fd,3.));
  }
  float smoke=texture(uFog,w*.7+vec2(uT*.008,0.)).r*1.8;
  vec3 air=texture(uAir,vUV).rgb+uGlow*uHaze*mix(1.,smoke,.5);
  if(uFloor<2.)air*=1.-.55*fx.a;
  vec3 c=alb*(uAmbient+E)*ao+air+refl+texture(uEmit,vUV).rgb;
  O=vec4(min(c,vec3(64.)),1.);
}`;

const DOWN_FS = HEAD + `
in vec2 vUV;out vec4 O;uniform sampler2D uT;uniform vec2 uH;
void main(){
  vec3 c=texture(uT,vUV).rgb*4.;
  c+=texture(uT,vUV-uH).rgb+texture(uT,vUV+uH).rgb+texture(uT,vUV+vec2(uH.x,-uH.y)).rgb+texture(uT,vUV-vec2(uH.x,-uH.y)).rgb;
  O=vec4(c/8.,1.);
}`;
const UP_FS = HEAD + `
in vec2 vUV;out vec4 O;uniform sampler2D uT;uniform vec2 uH;
void main(){
  vec3 c=texture(uT,vUV+vec2(-uH.x*2.,0.)).rgb+texture(uT,vUV+vec2(uH.x*2.,0.)).rgb+texture(uT,vUV+vec2(0.,uH.y*2.)).rgb+texture(uT,vUV-vec2(0.,uH.y*2.)).rgb;
  c+=(texture(uT,vUV+vec2(-uH.x,uH.y)).rgb+texture(uT,vUV+uH).rgb+texture(uT,vUV+vec2(uH.x,-uH.y)).rgb+texture(uT,vUV-uH).rgb)*2.;
  O=vec4(c/12.,1.);
}`;
const FILM_FS = HEAD + `
in vec2 vUV;out vec4 O;uniform sampler2D uScene,uBloom;uniform float uFrame;
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
void main(){
  vec3 c=texture(uScene,vUV).rgb;
  c=mix(c,texture(uBloom,vUV).rgb,.1);
  // sensor crosstalk: a very bright pure colour bleeds into its neighbours, so it clips to white
  c=mat3(.9,.05,.05,.05,.9,.05,.05,.05,.9)*c;
  vec2 p=vUV-.5;
  c*=1.-.5*dot(p,p);
  c=pow(aces(c),vec3(1./2.2));
  float g=ign(gl_FragCoord.xy+vec2(uFrame*5.588,uFrame*3.1))-.5;
  O=vec4(c+g*(1.6/255.+.012*(1.-c)*smoothstep(0.,.3,dot(c,vec3(.33)))),1.);
}`;

const POINT_STRIDE = 9, FLOOD_STRIDE = 12, POOL_STRIDE = 8;

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    this.gl = gl;
    if (!gl) return;
    this.float = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.frame = 0;
    this.w = 0;
    this.h = 0;

    const prog = (vs, fs) => this._link(vs, fs);
    this.p = {
      surfacePoint: prog(SURFACE_POINT_VS, SURFACE_POINT_FS),
      surfaceFlood: prog(SURFACE_FLOOD_VS, SURFACE_FLOOD_FS),
      pool: prog(POOL_VS, POOL_FS),
      airPoint: prog(AIR_POINT_VS, AIR_POINT_FS),
      airFlood: prog(AIR_FLOOD_VS, AIR_FLOOD_FS),
      emitPoint: prog(EMIT_POINT_VS, EMIT_POINT_FS),
      emitLens: prog(EMIT_LENS_VS, EMIT_LENS_FS),
      screen: prog(SCREEN_VS, SCREEN_FS),
      composite: prog(QUAD_VS, COMPOSITE_FS),
      down: prog(QUAD_VS, DOWN_FS),
      up: prog(QUAD_VS, UP_FS),
      film: prog(QUAD_VS, FILM_FS),
    };

    // one quad, three instance streams
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const stream = (layout, stride) => {
      const vao = gl.createVertexArray();
      const buf = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      let off = 0;
      layout.forEach((n, i) => {
        gl.enableVertexAttribArray(i + 1);
        gl.vertexAttribPointer(i + 1, n, gl.FLOAT, false, stride * 4, off * 4);
        gl.vertexAttribDivisor(i + 1, 1);
        off += n;
      });
      return { vao, buf, cap: 0 };
    };
    this.points = stream([2, 3, 4], POINT_STRIDE);
    this.floods = stream([2, 3, 4, 3], FLOOD_STRIDE);
    this.pools = stream([2, 3, 3], POOL_STRIDE);

    this.fog = this._fogTexture();
    this.tv = this._texture2D();
    this.pictures = new Map();
    this.fixtures = this._texture2D();
    gl.bindTexture(gl.TEXTURE_2D, this.tv);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.bindTexture(gl.TEXTURE_2D, this.fixtures);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.disable(gl.DEPTH_TEST);
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => location.reload());
  }

  _link(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(p));
    gl.deleteShader(v);
    gl.deleteShader(f);
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  _texture2D() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Tiling smoke: red is soft and billowy, green is finer. */
  _fogTexture() {
    const gl = this.gl;
    const S = 256;
    const hash = (x, y, p) => {
      let n = Math.imul(((x % p) + p) % p, 374761393) ^ Math.imul(((y % p) + p) % p, 668265263) ^ (p * 7919);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const vnoise = (x, y, p) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      let a = x - xi, b = y - yi;
      a = a * a * (3 - 2 * a); b = b * b * (3 - 2 * b);
      const l = (s, t, m) => s + (t - s) * m;
      return l(l(hash(xi, yi, p), hash(xi + 1, yi, p), a), l(hash(xi, yi + 1, p), hash(xi + 1, yi + 1, p), a), b);
    };
    const fbm = (u, v, base, oct) => {
      let s = 0, a = 0.5, p = base;
      for (let i = 0; i < oct; i++) { s += a * vnoise(u * p, v * p, p); a *= 0.5; p *= 2; }
      return s;
    };
    const px = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, i = (y * S + x) * 4;
        const r = fbm(u, v, 3, 5), g = fbm(u, v, 10, 4);
        px[i] = Math.min(255, Math.max(0, (r - 0.18) * 1.6 * 255));
        px[i + 1] = Math.min(255, Math.max(0, (g - 0.12) * 1.5 * 255));
        px[i + 2] = 0;
        px[i + 3] = 255;
      }
    }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  }

  _target(w, h, mips = false) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, this.float ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }

  /** Buffers follow the size of the stage on screen. */
  resize(w, h) {
    const gl = this.gl;
    if (!gl || (w === this.w && h === this.h) || w < 2 || h < 2) return;
    for (const t of this.targets || []) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    const third = (v) => Math.max(2, Math.round(v / 3));
    const half = (v) => Math.max(2, Math.round(v / 2));
    this.surface = this._target(third(w), third(h));
    this.air = this._target(half(w), half(h), true);
    this.emit = this._target(w, h, true);
    this.scene = this._target(w, h);
    this.bloom = [];
    let bw = w, bh = h;
    for (let i = 0; i < 6 && bw > 8 && bh > 8; i++) {
      bw = half(bw);
      bh = half(bh);
      this.bloom.push(this._target(bw, bh));
    }
    this.targets = [this.surface, this.air, this.emit, this.scene, ...this.bloom];
  }

  /** The fixture layer: hardware painted on transparency, or an opaque photo of the room. */
  setFixtures(canvas) {
    const gl = this.gl;
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, this.fixtures);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** The finished picture for one group of TVs. */
  setPicture(id, canvas) {
    const gl = this.gl;
    if (!gl || !canvas || canvas.width < 2) return;
    let t = this.pictures.get(id);
    if (!t) {
      t = this._texture2D();
      this.pictures.set(id, t);
    }
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }

  /** All pictures, small, for the light they throw on the room. */
  setSpill(canvas) {
    const gl = this.gl;
    if (!gl || !canvas || canvas.width < 2) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tv);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }

  _upload(stream, data, count, stride) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, stream.buf);
    const bytes = count * stride * 4;
    if (bytes > stream.cap) {
      stream.cap = Math.max(bytes * 2, 4096);
      gl.bufferData(gl.ARRAY_BUFFER, stream.cap, gl.DYNAMIC_DRAW);
    }
    if (count) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * stride);
  }

  _into(t) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
  }

  _tex(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  _use(prog, aspect) {
    this.gl.useProgram(prog.p);
    if (prog.u.uAspect) this.gl.uniform1f(prog.u.uAspect, aspect);
    return prog.u;
  }

  /**
   * scene: { aspect, floor, time, haze, ambient, glow:[r,g,b],
   *          points, nPoints, floods, nFloods, pools, nPools, screens:[{x,y,hw,hh,picture,region}] }
   */
  render(sc) {
    const gl = this.gl;
    if (!gl || !this.w) return;
    this.frame++;
    const { aspect, floor, time, haze } = sc;
    this._upload(this.points, sc.points, sc.nPoints, POINT_STRIDE);
    this._upload(this.floods, sc.floods, sc.nFloods, FLOOD_STRIDE);
    this._upload(this.pools, sc.pools, sc.nPools, POOL_STRIDE);
    gl.clearColor(0, 0, 0, 1);
    const drawPoints = () => { gl.bindVertexArray(this.points.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sc.nPoints); };
    const drawFloods = () => { gl.bindVertexArray(this.floods.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sc.nFloods); };

    // ---- light landing on surfaces
    this._into(this.surface);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    let u = this._use(this.p.surfacePoint, aspect);
    gl.uniform1f(u.uFloor, floor);
    this._tex(0, this.tv, u.uTV);
    if (sc.nPoints) drawPoints();
    u = this._use(this.p.surfaceFlood, aspect);
    gl.uniform1f(u.uFloor, floor);
    if (sc.nFloods) drawFloods();
    if (sc.nPools) {
      u = this._use(this.p.pool, aspect);
      gl.uniform1f(u.uFloor, floor);
      gl.bindVertexArray(this.pools.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sc.nPools);
    }

    // ---- light scattered by the air
    this._into(this.air);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (haze > 0) {
      u = this._use(this.p.airFlood, aspect);
      gl.uniform1f(u.uT, time);
      gl.uniform1f(u.uHaze, haze);
      this._tex(0, this.fog, u.uFog);
      if (sc.nFloods) drawFloods();
      u = this._use(this.p.airPoint, aspect);
      gl.uniform1f(u.uT, time);
      gl.uniform1f(u.uHaze, haze);
      this._tex(0, this.fog, u.uFog);
      this._tex(1, this.tv, u.uTV);
      if (sc.nPoints) drawPoints();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.air.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // ---- the sources
    this._into(this.emit);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const px = 1 / this.h;
    u = this._use(this.p.emitPoint, aspect);
    gl.uniform1f(u.uPx, px);
    this._tex(0, this.tv, u.uTV);
    if (sc.nPoints) drawPoints();
    u = this._use(this.p.emitLens, aspect);
    gl.uniform1f(u.uPx, px);
    if (sc.nFloods) drawFloods();
    if (sc.screens.length) {
      gl.disable(gl.BLEND);
      u = this._use(this.p.screen, aspect);
      gl.bindVertexArray(this.quadVao);
      for (const s of sc.screens) {
        const pic = this.pictures.get(s.picture);
        if (!pic) continue;
        this._tex(0, pic, u.uTV);
        gl.uniform4f(u.uRect, s.x, s.y, s.hw, s.hh);
        gl.uniform4f(u.uRegion, s.region[0], s.region[1], s.region[2], s.region[3]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.emit.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // ---- room x light + air + sources
    gl.disable(gl.BLEND);
    this._into(this.scene);
    u = this._use(this.p.composite, aspect);
    gl.uniform1f(u.uFloor, floor);
    gl.uniform1f(u.uAmbient, sc.ambient);
    gl.uniform1f(u.uHaze, haze);
    gl.uniform1f(u.uT, time);
    gl.uniform3f(u.uGlow, sc.glow[0], sc.glow[1], sc.glow[2]);
    this._tex(0, this.surface.tex, u.uSurface);
    this._tex(1, this.air.tex, u.uAir);
    this._tex(2, this.emit.tex, u.uEmit);
    this._tex(3, this.fixtures, u.uFixtures);
    this._tex(4, this.fog, u.uFog);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ---- bloom: down the chain, then back up adding each level
    u = this._use(this.p.down);
    let src = this.scene;
    for (const t of this.bloom) {
      this._into(t);
      gl.uniform2f(u.uH, 0.5 / src.w, 0.5 / src.h);
      this._tex(0, src.tex, u.uT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      src = t;
    }
    u = this._use(this.p.up);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 1; i > 0; i--) {
      const from = this.bloom[i], to = this.bloom[i - 1];
      this._into(to);
      gl.uniform2f(u.uH, 0.5 / from.w, 0.5 / from.h);
      this._tex(0, from.tex, u.uT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);

    // ---- film
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    u = this._use(this.p.film);
    gl.uniform1f(u.uFrame, this.frame % 512);
    this._tex(0, this.scene.tex, u.uScene);
    this._tex(1, this.bloom[0].tex, u.uBloom);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
