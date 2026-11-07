// The visual library. Each visual is a small field function: for every braille dot
// it returns (intensity, colour position). The renderer turns that into glyphs.
//
// In scope for every field():
//   uT     motion time, in beats scaled by speed and energy
//   uB     raw beat position, for things that land on the grid
//   uKick  1 on the hit, decaying
//   uE     energy, 0 moody to 1 harsh
//   stepOf(d) / phaseOf(d)  a counter at d steps per beat, snapped down to 1, 2, 4, 8...
//                           so it stays on the beat, and capped by the flash limit
//   uZoom  how far a group of TVs has zoomed in; the visible height is 2/uZoom
//   prev(uv)  last frame's (intensity, colour), for feedback; uPrev has mip levels

export const STYLES = [['braille', 'Braille'], ['ascii', 'ASCII'], ['lines', 'Lines'], ['dots', 'Dots'], ['grain', 'Grain'], ['blocks', 'Blocks']];
export const COLORS = [['palette', 'Palette'], ['mono', 'White'], ['thermal', 'Thermal'], ['ice', 'Ice']];
export const DETAIL = [[80, 'Coarse'], [120, 'Medium'], [160, 'Fine'], [220, 'Finest']];
export const MOODS = [['moody', 'Moody'], ['dynamic', 'Dynamic'], ['harsh', 'Harsh']];
// Plain full-screen pictures, with no glyphs and nothing to compile.
export const SOLIDS = [['none', 'Black'], ['white', 'White'], ['strobe', 'Strobe']];
export const STROBE_RATES = [[1, '1 beat'], [2, '1/2'], [4, '1/4'], [8, '1/8'], [16, '1/16']];
export const isSolid = (id) => SOLIDS.some(([k]) => k === id);
export const BASE = { id: 'currents', style: 'braille', color: 'palette', cols: 160, speed: 1, energy: 0.5, scale: 1, glow: 0.5 };

// ------------------------------------------------------------------ flow sim (runs on the CPU)
function hash3(i, j, k) {
  let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let u = x - xi, v = y - yi, w = z - zi;
  u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); w = w * w * (3 - 2 * w);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w);
}

/** Stream function on a coarse grid; particles read its curl, so flow never bunches up. */
function flowField(gw, gh) {
  const psi = new Float32Array((gw + 1) * (gh + 1));
  return {
    update(t, aspect) {
      let k = 0;
      for (let j = 0; j <= gh; j++) {
        for (let i = 0; i <= gw; i++) {
          const x = (i / gw - 0.5) * 2 * aspect, y = (j / gh - 0.5) * 2;
          psi[k++] = noise3(x * 0.9 + 11, y * 0.9 + 3, t) + 0.5 * noise3(x * 2.1 + 5, y * 2.1 + 17, t * 1.3) + 0.2 * noise3(x * 4.6, y * 4.6 + 9, t * 1.7);
        }
      }
    },
    velocity(x, y, aspect, out) {
      const fx = Math.min(gw - 1.001, Math.max(0, (x / aspect / 2 + 0.5) * gw));
      const fy = Math.min(gh - 1.001, Math.max(0, (y / 2 + 0.5) * gh));
      const i = fx | 0, j = fy | 0, a = fx - i, b = fy - j, W = gw + 1;
      const p = (u, v) => psi[v * W + u];
      const dy = (p(i, j + 1) - p(i, j)) * (1 - a) + (p(i + 1, j + 1) - p(i + 1, j)) * a;
      const dx = (p(i + 1, j) - p(i, j)) * (1 - b) + (p(i + 1, j + 1) - p(i, j + 1)) * b;
      out[0] = dy * gh / 2;
      out[1] = -dx * gw / 2 / aspect;
    },
  };
}

function currentsSim(n) {
  const px = new Float32Array(n), py = new Float32Array(n), life = new Float32Array(n), max = new Float32Array(n);
  const data = new Float32Array(n * 8);
  const flow = flowField(72, 40);
  const v = [0, 0];
  let seeded = false, frame = 0;
  const spawn = (i, aspect) => {
    px[i] = (Math.random() * 2 - 1) * aspect; py[i] = Math.random() * 2 - 1;
    max[i] = 40 + Math.random() * 140; life[i] = seeded ? 0 : Math.random() * max[i];
  };
  return {
    prim: 'lines', count: n * 2, data,
    update(u) {
      if (!seeded) { for (let i = 0; i < n; i++) spawn(i, u.aspect); seeded = true; }
      if (frame++ % 2 === 0) flow.update(u.T * 0.035, u.aspect);
      const dt = u.dT * 0.1 + u.dB * u.kick * 0.09 * (0.3 + u.E);
      let w = 0;
      for (let i = 0; i < n; i++) {
        flow.velocity(px[i], py[i], u.aspect, v);
        const sp = Math.hypot(v[0], v[1]);
        const x0 = px[i], y0 = py[i];
        px[i] += v[0] * dt; py[i] += v[1] * dt;
        life[i] += 1;
        const f = life[i] / max[i];
        const a = Math.min(1, f * 8) * Math.min(1, (1 - f) * 6) * (0.42 + u.kick * 0.3) * u.density;
        const c = Math.min(1, sp * 0.55);
        data[w++] = x0; data[w++] = y0; data[w++] = a; data[w++] = c;
        data[w++] = px[i]; data[w++] = py[i]; data[w++] = a; data[w++] = c;
        if (f >= 1 || Math.abs(px[i]) > u.aspect + 0.05 || Math.abs(py[i]) > 1.05) spawn(i, u.aspect);
      }
    },
  };
}

function orbitSim(n) {
  const th = new Float32Array(n), ph = new Float32Array(n), r = new Float32Array(n);
  const data = new Float32Array(n * 4);
  const init = () => {
    for (let i = 0; i < n; i++) {
      th[i] = Math.random() * Math.PI * 2;
      ph[i] = Math.acos(Math.random() * 2 - 1);
      r[i] = 0.82;
    }
  };
  init();
  return {
    prim: 'points', count: n, data,
    update(u) {
      const t = u.T * 0.05, R = 0.82 * (1 + u.kick * 0.03);
      const ca = Math.cos(t * 0.7), sa = Math.sin(t * 0.7), cb = Math.cos(t * 0.31), sb = Math.sin(t * 0.31);
      let w = 0;
      for (let i = 0; i < n; i++) {
        const s = Math.sin(ph[i]);
        const q = noise3(Math.cos(th[i]) * s * 1.6 + 7, Math.sin(th[i]) * s * 1.6, Math.cos(ph[i]) * 1.6 + t);
        const q2 = noise3(Math.cos(th[i]) * s * 1.6, Math.sin(th[i]) * s * 1.6 + 5, Math.cos(ph[i]) * 1.6 - t);
        th[i] += (q - 0.5) * u.dT * 0.5 / Math.max(s, 0.25);
        ph[i] = Math.max(0.05, Math.min(3.09, ph[i] + (q2 - 0.5) * u.dT * 0.5));
        const sp = Math.sin(ph[i]);
        const x = Math.cos(th[i]) * sp, y = Math.cos(ph[i]), z = Math.sin(th[i]) * sp;
        const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
        const y2 = y * cb - z1 * sb, z2 = y * sb + z1 * cb;
        data[w++] = x1 * R; data[w++] = y2 * R;
        data[w++] = ((z2 * 0.5 + 0.5) ** 2 * (0.3 + u.kick * 0.3) + 0.03) * u.density;
        data[w++] = Math.min(1, q * 1.3);
      }
    },
  };
}

// ------------------------------------------------------------------ the library
export const VISUALS = [
  // ---- moody: slow, dark, organic
  { id: 'smoke', name: 'Smoke', mood: 'moody', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.05;
  vec2 q=vec2(fbm(p*.9+vec2(0,t)),fbm(p*.9+vec2(5.2,1.3-t)));
  vec2 r=vec2(fbm(p*.9+3.2*q+vec2(1.7,9.2)+t*.7),fbm(p*.9+3.2*q+vec2(8.3,2.8)-t*.5));
  float f=fbm(p*.9+3.6*r);
  float i=pow(sat((f-.42)*2.7),3.2-uE*1.2)*(1.+uKick*.45*uE);
  return vec2(i,sat(length(q)*.85+r.x*.25));
}` },
  { id: 'contours', name: 'Contours', mood: 'moody', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.03;
  float r=length(p);
  float f=fbm3(vec3(p*.8,t))+uKick*.02*exp(-r*1.5);
  float n=9.+uE*12.;
  float x=f*n;
  float d=abs(fract(x+.5)-.5)/max(fwidth(x),1e-3);
  float major=step(mod(floor(x+.5),4.),.5);
  float line=(1.-smoothstep(.4,1.4,d))*(.5+.5*major);
  return vec2(line+pow(f,5.)*.25,sat(f*1.5-.2));
}` },
  { id: 'aurora', name: 'Aurora', mood: 'moody', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.05;
  float x=p.x*.8+.3*sin(p.y*1.3+t*2.)+.5*fbm(vec2(p.x*.5,t));
  float v=0.;
  for(float k=0.;k<3.;k++){
    float c=noise(vec2(x*(2.6+k*1.8)+k*7.,t*(1.+k*.3)));
    float base=-.62+k*.26+.3*noise(vec2(x*1.1+k,t*.5));
    float y=p.y-base;
    v+=pow(c,2.6)*1.7*smoothstep(-.16,.08,y)*exp(-max(y,0.)*(1.4+k*.5));
  }
  v*=.7+.3*noise(vec2(x*30.,t*3.));
  return vec2(v*(1.+uKick*.3*uE),sat(.15+(p.y+1.)*.42));
}` },
  { id: 'ribbons', name: 'Ribbons', mood: 'moody', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.09;float v=0.,c=0.;
  for(float k=0.;k<5.;k++){
    float o=k*1.7;
    float y=sin(p.x*(.7+.1*k)+t+o)*.5+sin(p.x*1.9-t*.8+o*2.)*.17+(k-2.)*.12;
    float w=.11+.08*sin(p.x*1.1+t*.7+o);
    float d=(p.y-y)/max(w,.02);
    float a=exp(-d*d)*(.5+.5*sin(d*7.+t*2.+o));
    if(a>v){v=a;c=k/4.;}
  }
  return vec2(pow(v,1.25)*(.85+.4*uKick),sat(c*.8+.1));
}` },
  { id: 'rain', name: 'Rain', mood: 'moody', glsl: `
vec2 field(vec2 uv, vec2 p){
  float cx=floor(uv.x*uRes.x*.5);
  float sp=.25+hash(cx)*.9;
  float d=1.+hash(cx+7.)*2.;
  float y=(uv.y+uT*.09*sp+hash(cx+3.)*10.)*d;
  float seg=fract(y);
  float on=step(.42,hash(cx+9.+floor(y)));
  float i=on*pow(seg,5.)*(.9+.5*uKick);
  return vec2(i,sat(seg*.7+hash(cx)*.3));
}` },
  { id: 'halo', name: 'Halo', mood: 'moody', defaults: { color: 'thermal' }, glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.04;
  vec2 q=p+.09*(vec2(fbm(p*2.+t),fbm(p*2.-t+4.))-.5);
  float r=length(q),a=atan(q.y,q.x);
  float R=.6+.04*sin(a*3.+t*2.);
  float e=(r-R)/.17;
  float v=.34*exp(-e*e);
  for(float k=0.;k<7.;k++){
    float ang=k/7.*TAU+t*(mod(k,2.)<.5?1.:-.6)+sin(t*1.7+k)*.25;
    vec2 d=q-R*vec2(cos(ang),sin(ang));
    float s=.11+.04*sin(t*3.+k*2.)+.035*uKick;
    v+=exp(-dot(d,d)/(s*s))*.9;
  }
  return vec2(sat(v*.9),sat(v*.78));
}` },
  { id: 'wings', name: 'Wings', mood: 'moody', defaults: { color: 'ice' }, glsl: `
float wing(vec2 q){
  vec2 a=rot(.65)*(q-vec2(.44,.3));
  vec2 b=rot(-.45)*(q-vec2(.32,-.3));
  float d1=length(a*vec2(1.,1.55))-.42;
  float d2=length(b*vec2(1.2,1.05))-.29;
  float h=sat(.5+.5*(d2-d1)/.14);
  return mix(d2,d1,h)-.14*h*(1.-h);
}
vec2 field(vec2 uv, vec2 p){
  float t=uT*.06;
  float flap=.6+.4*cos(t*2.+sin(t*.7));
  vec2 s=rot(sin(t*.8)*.18)*(p/1.15);
  vec2 q=vec2(abs(s.x)/max(flap,.16),s.y);
  q+=.05*(vec2(fbm(s*2.2+t),fbm(s*2.2-t))-.5);
  float d=wing(q);
  float rim=exp(-abs(d)*16.);
  float ang=atan(q.y,q.x);
  float vein=.55+.45*sin(ang*20.+fbm(q*3.)*5.);
  float inner=smoothstep(.02,-.45,d)*vein*.75;
  float body=exp(-abs(s.x)*40.)*smoothstep(.5,.2,abs(s.y));
  float i=(rim+inner*(1.+uKick*.35)+body*.8)*smoothstep(.0,.25,flap+.2);
  return vec2(i,sat(.2+length(q)*.75));
}` },
  { id: 'drift', name: 'Drift', mood: 'moody', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.025;
  vec2 q=p*.7+vec2(fbm(p*.6+t),fbm(p*.6-t+6.))*1.7;
  float f=fbm(q+vec2(t,-t));
  float comb=pow(.5+.5*sin(f*(46.+uE*30.)+t*6.),5.);
  float mask=smoothstep(.3,.62,fbm(p*.8-t*1.5+3.));
  return vec2(comb*mask*(1.+uKick*.35),sat(f*1.5-.1));
}` },
  { id: 'comet', name: 'Comet', mood: 'moody', defaults: { style: 'grain', cols: 220, glow: 0.2 }, glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.05;
  vec2 q=rot(-.85)*p;
  q.y+=.25*sin(q.x*.6+t*2.);
  float w=fbm(vec2(q.x*.28-t*1.6,q.y*3.4));
  float w2=fbm(vec2(q.x*.5-t*2.2,q.y*7.+4.));
  float mask=smoothstep(1.1,.1,abs(q.y+.15))*smoothstep(-1.8,.2,q.x)*smoothstep(2.3,.8,q.x);
  float i=pow(sat(w*1.55-.32),2.6)*mask*1.9;
  i+=pow(sat(w2*1.5-.5),3.)*mask;
  return vec2(i*(.9+.55*uKick),sat(1.-i*.8));
}` },

  // ---- dynamic: flowing, always moving, pushed by the beat
  { id: 'currents', name: 'Currents', mood: 'dynamic', fill: false, sim: (thumb, units = 1) => currentsSim(thumb ? 1600 : Math.round(9000 * units)), glsl: `
vec2 field(vec2 uv, vec2 p){
  vec2 s=prev(uv);
  return vec2(s.x*(.968-.02*uE),s.y);
}` },
  { id: 'ink', name: 'Ink', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.04;
  vec2 v=curl(p*1.3,t)*.0052*(1.+uE*1.6);
  vec2 s=prev(uv-v*vec2(1./uAspect,1.));
  float i=s.x*.991,c=s.y;
  for(float k=0.;k<3.;k++){
    vec2 at=vec2(sin(t*3.1+k*2.1)*.85*uAspect,cos(t*2.3+k*1.3)*.62)/uZoom;
    float e=exp(-dot(p-at,p-at)*150.)*(.035+.5*uKick*step(mod(floor(uB)+k,3.),.5));
    c=mix(c,k/2.,sat(e*4.));
    i+=e;
  }
  return vec2(min(i,1.2),c);
}` },
  { id: 'bloom', name: 'Bloom', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.05;
  p*=1.-.1*uKick*(.3+uE);
  vec2 w=vec2(fbm(p*1.5+t),fbm(p*1.5-t+9.))-.5;
  vec2 q=p+w*.42;
  float r=length(q),a=atan(q.y,q.x)+t*.45;
  float v=0.,c=0.;
  for(float k=0.;k<4.;k++){
    float n=5.+k*2.;
    float pet=pow(.5+.5*cos(a*n+k*1.4+sin(t*2.+k)*1.2),.8);
    float R=(.24+k*.17)*(.72+.38*pet)+.05*sin(t*1.3+k);
    float d=r-R;
    float vein=.72+.28*sin(a*n*6.+r*26.-t*3.);
    float l=(exp(-abs(d)*(24.-k*3.))*.95+smoothstep(0.,-.32,d)*.2)*vein*(1.-k*.1);
    if(l>v){v=l;c=k/3.;}
  }
  return vec2(v*smoothstep(1.6,.65,r),sat(c*.75+r*.3));
}` },
  { id: 'ridges', name: 'Ridges', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  float v=0.,c=0.;
  float t=uT*.07;
  for(int n=0;n<22;n++){
    float k=float(n)/22.;
    float y0=-.95+k*1.75;
    float env=exp(-p.x*p.x*(1.9-.4*k));
    float nz=noise(vec2(p.x*2.5+k*9.,t+k*3.))*.75+noise(vec2(p.x*6.+k*5.,t*1.4+k))*.25;
    float h=y0+(.42-.16*k)*env*pow(nz*1.2,2.4)*(1.+uKick*.75);
    float d=p.y-h;
    if(d<0.){v=max(v,exp(d*90.)*.5);break;}
    float l=exp(-d*85.);
    if(l>v){v=l;c=1.-k;}
  }
  return vec2(v,sat(c));
}` },
  { id: 'swell', name: 'Swell', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  float yy=.5-p.y;
  if(yy<=.012) return vec2(0.);
  float z=1./yy,x=p.x*z;
  float t=uT*.12;
  vec2 w=vec2(x*.5,z*.5+t);
  float h=sin(w.x*1.3+w.y*.9)+.6*sin(w.x*2.1-w.y*1.4+t*.4)+fbm(w*.7)*1.6;
  h*=1.+uKick*.6;
  float gz=z*2.6+h*.62+t*5.;
  float d=abs(fract(gz)-.5)/max(fwidth(gz),1e-3);
  float line=1.-smoothstep(.3,1.4,d);
  float fog=exp(-z*.2);
  return vec2(line*fog*(.6+.5*h*h)*1.5,sat(h*.24+.45));
}` },
  { id: 'tunnel', name: 'Tunnel', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  p+=.28*vec2(sin(uT*.05),cos(uT*.037));
  float r=length(p),a=atan(p.y,p.x);
  float z=.5/max(r,.02);
  float tt=uT*.32+uKick*.14;
  float v=z+tt;
  float x=v*1.4;
  float ring=1.-smoothstep(.35,1.4,abs(fract(x)-.5)/max(fwidth(x),1e-3));
  float rib=pow(.5+.5*cos(a*12.+sin(v*.7)*2.),7.);
  float n=fbm(vec2(a*2.+sin(v)*.3,v*.7));
  float i=(ring*.9+rib*.45+n*n*.85)*exp(-z*.11)*smoothstep(.02,.16,r);
  return vec2(i*(1.+uKick*.4),sat(fract(v*.13)*.8+n*.2));
}` },
  { id: 'moire', name: 'Moiré', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.05;
  vec2 c1=vec2(sin(t*1.7),cos(t*1.3))*.55,c2=vec2(-sin(t*1.1),sin(t*.9))*.65;
  float k=26.+8.*sin(t)+uE*18.;
  float a=sin(length(p-c1)*k-uT*.28),b=sin(length(p-c2)*k+uT*.21);
  float i=sat(a*b*1.25+.12)*smoothstep(1.9,.5,length(p));
  return vec2(i*(.8+.5*uKick),sat(.5+.5*a*b-length(p)*.1));
}` },
  { id: 'melt', name: 'Melt', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  vec2 off=vec2((noise(vec2(uv.x*14.,uT*.15))-.5)*.0018,.0028+.0075*noise(vec2(uv.x*24.+3.,uT*.07)));
  vec2 s=prev(uv+off);
  float f=fbm3(vec3(p*1.25,uT*.035));
  float src=smoothstep(.54,.68,f)*(.45+.6*uKick);
  float i=s.x*.992,c=s.y;
  if(src>i){i=src;c=sat(f*1.8-.5);}
  return vec2(i,c);
}` },
  { id: 'skin', name: 'Skin', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  // reaction-diffusion: near neighbours minus far neighbours grows into cells and worms
  vec2 px=1./uRes,flow=curl(p*.8,uT*.02)*.0006;
  float near=0.,far=0.;
  for(float k=0.;k<8.;k++){
    vec2 d=vec2(cos(k*.7854+.39),sin(k*.7854+.39));
    near+=textureLod(uPrev,uv-flow+d*px*2.,0.).r;
    far+=textureLod(uPrev,uv-flow+d*px*5.5,0.).r;
  }
  near/=8.;far/=8.;
  float v=near+(near-far)*(1.25+.25*uE)-.012;
  v+=(noise3(vec3(p*9.,uT*.3))-.5)*.035;
  v+=exp(-dot(p,p)*(10.-uKick*8.))*uKick*.16;
  v=sat(v);
  return vec2(v*.92,sat(far*1.5+length(p)*.14));
}` },
  { id: 'liquid', name: 'Liquid', mood: 'dynamic', defaults: { glow: 0.3 }, glsl: `
float surf(vec2 p,float t){
  float v=0.;
  for(float k=0.;k<6.;k++){
    vec2 c=vec2(sin(t*(1.1+k*.13)+k*2.4)*(.62+.1*k)*uAspect*.7,cos(t*(.9+k*.17)+k*1.3)*.62)/uZoom;
    v+=(.09+.02*sin(t+k)+.04*uKick)/(dot(p-c,p-c)+.02);
  }
  return v;
}
vec2 field(vec2 uv, vec2 p){
  float t=uT*.05;
  vec2 q=p+.07*(vec2(fbm(p*2.2+t),fbm(p*2.2-t))-.5);
  float h=surf(q,t);
  float inside=smoothstep(.95,1.2,h);
  const float e=.012;
  vec2 g=vec2(surf(q+vec2(e,0.),t)-h,surf(q+vec2(0.,e),t)-h)/e;
  vec3 n=normalize(vec3(-g*.05,1.));
  float spec=pow(sat(dot(n,normalize(vec3(.45,.6,.7)))),14.);
  float band=.5+.5*sin(n.x*6.+n.y*4.+t*2.);
  float rim=pow(1.-n.z,1.5);
  return vec2(inside*(spec*1.1+rim*.75+band*.26+.06),sat(band*.8+n.y*.25));
}` },
  { id: 'vortex', name: 'Vortex', mood: 'dynamic', glsl: `
vec2 field(vec2 uv, vec2 p){
  float t=uT*.08;
  float r=length(p),a=atan(p.y,p.x);
  float arms=3.;
  float s=a*arms+log(r+.04)*5.5-t*2.4;
  float n=fbm(vec2(s*.9,r*3.-t));
  float arm=pow(.5+.5*cos(s+n*2.6),3.);
  float core=exp(-r*5.)*1.1;
  float i=arm*smoothstep(1.7,.25,r)*(.4+n)+core;
  return vec2(i*(1.+uKick*.5),sat(r*.7+n*.35));
}` },
  { id: 'orbit', name: 'Orbit', mood: 'dynamic', sim: (thumb) => orbitSim(thumb ? 500 : 5000), simPoint: 1.2, glsl: `
vec2 field(vec2 uv, vec2 p){
  vec2 s=prev(uv);
  float v=0.;
  float R=.82*(1.+uKick*.03);
  for(float k=0.;k<4.;k++){
    vec2 q=rot(uT*(.016+.006*k)+k*1.2)*p;
    float sq=cos(uT*(.03+.01*k)+k*2.);
    float e=abs(length(vec2(q.x,q.y/max(abs(sq),.05)))-R)*abs(sq);
    v=max(v,(1.-smoothstep(.0,.012,e))*.32);
  }
  float i=max(v,s.x*.72);
  return vec2(i,v>s.x*.72?.9:s.y);
}` },

  // ---- harsh: quick changes, hard cuts
  { id: 'shards', name: 'Shards', mood: 'harsh', glsl: `
vec2 field(vec2 uv, vec2 p){
  float d=mix(1.,4.,uE),s=stepOf(d);
  vec2 q=rot(hash(s+5.)*.7)*p*(2.+hash(s+1.)*1.5)+vec2(hash(s),hash(s+3.))*5.;
  vec2 g=floor(q),f=fract(q),id=vec2(0.);float d1=9.,d2=9.;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec2 b=vec2(float(x),float(y));
    vec2 r=b+hash2(g+b)-f;
    float e=dot(r,r);
    if(e<d1){d2=d1;d1=e;id=g+b;}else if(e<d2)d2=e;
  }
  float edge=1.-smoothstep(0.,.05,sqrt(d2)-sqrt(d1));
  float on=step(.48,hash(id+s*.37));
  float i=on*(.3+.7*hash(id+s))*(1.-.65*phaseOf(d))+edge*.9;
  return vec2(i,hash(id+7.));
}` },
  { id: 'tear', name: 'Tear', mood: 'harsh', glsl: `
vec2 field(vec2 uv, vec2 p){
  float s=stepOf(mix(2.,8.,uE));
  float band=floor(uv.y*mix(6.,26.,hash(s)));
  float off=(hash(band+s)-.5)*step(.4,hash(band*1.3+s))*1.3;
  vec2 q=p+vec2(off,0.);
  float f=fbm(q*1.5+vec2(uT*.05,floor(s/4.)*.17));
  float i=smoothstep(.43,.47,f);
  if(hash(band+s*2.)>.82)i=1.-i;
  i*=.5+.5*hash(band*3.+s);
  return vec2(i,sat(hash(floor(s/4.))*.6+f*.5));
}` },
  { id: 'bars', name: 'Bars', mood: 'harsh', glsl: `
vec2 field(vec2 uv, vec2 p){
  float d=mix(1.,4.,uE),s=stepOf(d);
  float x=step(.5,hash(floor(uB/4.)+1.))>.5?uv.x:uv.y;
  float n=2.+floor(hash(s+1.)*14.);
  float idx=floor(x*n);
  float i=step(.5,hash(idx+s*1.3))*(1.-.8*phaseOf(d));
  return vec2(i,hash(idx*.7+floor(s/2.)));
}` },
  { id: 'shock', name: 'Shock', mood: 'harsh', glsl: `
vec2 field(vec2 uv, vec2 p){
  float v=0.,c=0.;
  for(float k=0.;k<4.;k++){
    float bi=floor(uB)-k,age=uB-bi;
    vec2 at=(vec2(hash(bi),hash(bi+9.))-.5)*vec2(uAspect,1.)*1.7*uE/uZoom;
    float r=length(p-at);
    float rad=age*(.75+uE*1.3);
    float w=.05+.08*age;
    float l=(1.-smoothstep(w*.5,w,abs(r-rad)))*pow(1.-age/4.,2.);
    if(l>v){v=l;c=fract(bi*.27);}
  }
  v=max(v,pow(uKick,5.)*.7*exp(-dot(p,p)*2.5));
  return vec2(v,c);
}` },
  { id: 'static', name: 'Static', mood: 'harsh', defaults: { glow: 0.15 }, glsl: `
vec2 field(vec2 uv, vec2 p){
  float s=stepOf(mix(2.,8.,uE));
  float gate=step(mix(.72,.28,uE),hash(s));
  float n=hash(floor(uv*uRes)+fract(uTime)*91.);
  float roll=step(.9,fract(uv.y*3.+uB*.25));
  float i=step(mix(.82,.45,gate),n)*(gate*.95+.1)+roll*step(.5,n)*.5;
  return vec2(i,hash(floor(s/2.)+floor(uv.y*5.)));
}` },
  { id: 'blocks', name: 'Blocks', mood: 'harsh', glsl: `
vec2 field(vec2 uv, vec2 p){
  float d=mix(1.,4.,uE),s=stepOf(d);
  vec2 q=uv,id=vec2(0.);
  for(int n=0;n<5;n++){
    vec2 g=floor(q*2.);
    id=id*2.+g;
    q=fract(q*2.);
    if(hash(id+s*.31+float(n))<.34)break;
  }
  float on=step(.5,hash(id+s));
  float edge=1.-smoothstep(0.,.03,min(min(q.x,q.y),min(1.-q.x,1.-q.y)));
  return vec2(on*(.35+.65*hash(id+s+1.))*(1.-.6*phaseOf(d))+edge*.25,hash(id));
}` },
  { id: 'cutup', name: 'Cutup', mood: 'harsh', glsl: `
vec2 field(vec2 uv, vec2 p){
  float s=stepOf(uE>.6?2.:1.);
  vec2 off=vec2(hash(s),hash(s+1.))*40.;
  vec2 q=rot(hash(s+3.)*TAU)*p*(.6+hash(s+2.)*2.4)+off;
  float f=fbm(q+1.1*fbm(q+uT*.1));
  float i=pow(sat((f-.33)*2.9),1.5);
  if(uE>.6&&mod(s,2.)>.5)i=1.-i;
  return vec2(i*(1.+uKick*.3),sat(f*1.2-.1+hash(s+4.)*.3));
}` },
  { id: 'radar', name: 'Radar', mood: 'harsh', glsl: `
vec2 field(vec2 uv, vec2 p){
  float rate=mix(.125,.5,uE);
  float dir=mod(floor(uB/8.),2.)<.5?1.:-1.;
  float a=atan(p.y,p.x),ang=dir*uB*TAU*rate;
  float e=mod(a-ang,TAU);
  float beam=exp(-min(e,TAU-e)*16.);
  float r=length(p);
  vec2 s=prev(uv);
  float n=noise(vec2(r*9.,floor(uB)+a*2.));
  float i=max(s.x*mix(.965,.93,uE),beam*(.3+.8*n));
  float ring=(1.-smoothstep(0.,.012,abs(fract(r*2.5)-.5)-.48))*.1;
  return vec2(max(i,ring),beam>.15?sat(r*.7+n*.2):s.y);
}` },
  { id: 'warp', name: 'Warp', mood: 'harsh', glsl: `
vec2 field(vec2 uv, vec2 p){
  float a=atan(p.y,p.x),r=length(p);
  float n=64.,x=a/TAU*n,id=floor(x);
  float sp=.5+hash(id)*1.5;
  float z=fract(hash(id+4.)+uT*.28*sp);
  float rr=z*z*2.4;
  float len=.08+rr*.55+uKick*.5;
  float streak=step(abs(fract(x)-.5),.1+.12*hash(id+2.))*smoothstep(rr-len,rr,r)*step(r,rr);
  return vec2(streak*(.35+.65*z)*(1.+uKick*.5),sat(hash(id+6.)*.5+z*.5));
}` },
];

const byId = new Map(VISUALS.map((v) => [v.id, v]));
export const visualDef = (id) => byId.get(id) || null;
export const visualName = (id) => SOLIDS.find(([k]) => k === id)?.[1] || byId.get(id)?.name || '';

/** A scene's stored visual with library and base defaults filled in. */
export function resolveVisual(v) {
  const id = v?.id ?? BASE.id;
  if (isSolid(id)) return { ...BASE, rate: 4, ...v, id };
  const def = byId.get(id) || byId.get(BASE.id);
  return { ...BASE, ...def.defaults, ...v, id: def.id };
}
