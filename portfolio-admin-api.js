const DEFAULT_PROJECTS_URL="https://raw.githubusercontent.com/Elshorihy/Portfolio-/main/projects.json";
const TTL=28800;
export default {async fetch(request,env){
 const origin=request.headers.get("Origin")||"",allowed=(env.ALLOWED_ORIGIN||"https://elshorihy.github.io").split(",").map(s=>s.trim()),cors=allowed.includes(origin)?origin:allowed[0];
 if(request.method==="OPTIONS")return new Response(null,{status:204,headers:corsHeaders(cors)});
 const url=new URL(request.url);
 try{
  if(url.pathname==="/health"){const kvConfigured=!!env.PROJECTS_KV;return json({ok:kvConfigured,service:"portfolio-admin-api",kvConfigured},kvConfigured?200:503,cors)}
  if(url.pathname==="/login"&&request.method==="POST"){
   const b=await request.json();if(!env.ADMIN_PASSWORD||typeof b.password!=="string"||!equal(b.password,env.ADMIN_PASSWORD))return json({error:"كلمة السر غير صحيحة"},401,cors);
   return json({token:await makeToken(env.ADMIN_PASSWORD,TTL),expiresIn:TTL},200,cors);
  }
  if(url.pathname==="/settings"&&request.method==="GET"){if(!env.PROJECTS_KV)return json({error:"إعداد KV غير مكتمل في Cloudflare Worker."},503,cors);return json({settings:await readSettings(env)},200,cors,{"Cache-Control":"no-store"})}
  if(url.pathname==="/settings"&&request.method==="PUT"){
   if(!env.PROJECTS_KV)return json({error:"إعداد KV غير مكتمل في Cloudflare Worker."},503,cors);
   const auth=(request.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
   if(!await verifyToken(auth,env.ADMIN_PASSWORD))return json({error:"جلسة الإدارة انتهت، سجّل الدخول من جديد"},401,cors);
   const b=await request.json();if(!b||!b.settings||typeof b.settings!=="object")return json({error:"إعدادات الموقع غير صالحة"},400,cors);
   const s=normalizeSettings(b.settings);await env.PROJECTS_KV.put("settings",JSON.stringify(s));return json({ok:true},200,cors);
  }
  if(url.pathname==="/projects"&&request.method==="GET"){if(!env.PROJECTS_KV)return json({error:"إعداد KV غير مكتمل في Cloudflare Worker."},503,cors);return json({projects:await readProjects(env)},200,cors,{"Cache-Control":"no-store"})}
  if(url.pathname==="/projects"&&request.method==="PUT"){
   if(!env.PROJECTS_KV)return json({error:"إعداد KV غير مكتمل في Cloudflare Worker."},503,cors);
   const auth=(request.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
   if(!await verifyToken(auth,env.ADMIN_PASSWORD))return json({error:"جلسة الإدارة انتهت، سجّل الدخول من جديد"},401,cors);
   const b=await request.json();if(!b||!Array.isArray(b.projects)||b.projects.length>200)return json({error:"قائمة المشاريع غير صالحة (الحد الأقصى 200)"},400,cors);
   const projects=b.projects.map(normalizeProject);await env.PROJECTS_KV.put("projects",JSON.stringify(projects));return json({ok:true,count:projects.length},200,cors);
  }
  return json({error:"Not found"},404,cors);
 }catch(e){console.error(e);return json({error:"خطأ داخلي. تأكد من إعداد KV ورابط projects.json."},500,cors)}
}};
async function readProjects(env){const saved=await env.PROJECTS_KV.get("projects");if(saved){const a=JSON.parse(saved);if(Array.isArray(a))return a}const r=await fetch(env.INITIAL_PROJECTS_URL||DEFAULT_PROJECTS_URL,{cf:{cacheTtl:0}});if(!r.ok)throw Error("initial projects unavailable");const d=await r.json(),a=Array.isArray(d.projects)?d.projects:[];await env.PROJECTS_KV.put("projects",JSON.stringify(a));return a}
async function readSettings(env){const saved=await env.PROJECTS_KV.get("settings");if(saved){try{return normalizeSettings(JSON.parse(saved))}catch{}}return normalizeSettings({})}
function normalizeSettings(s){const t=v=>String(v??"").trim();const image=v=>{const x=t(v);if(/^data:image\/(jpeg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(x)&&x.length<=1800000)return x;return safeUrl(x)};const hex=v=>/^#[0-9a-f]{6}$/i.test(t(v))?t(v):"";return{brandName:t(s.brandName).slice(0,80),logo:image(s.logo),heroName:t(s.heroName).slice(0,80),role:t(s.role).slice(0,120),description:t(s.description).slice(0,500),title:t(s.title).slice(0,150),metaDescription:t(s.metaDescription).slice(0,300),accent:hex(s.accent)||"#00f2fe",accent2:hex(s.accent2)||"#4facfe"}}
function normalizeProject(p,i){const t=v=>String(v??"").trim();return{id:t(p.id).slice(0,80)||"p"+(i+1),name:t(p.name).slice(0,120),description:t(p.description).slice(0,500),category:["3d","store","game","web","other"].includes(t(p.category))?t(p.category):"other",url:safeUrl(p.url),image:safeImage(p.image),technologies:Array.isArray(p.technologies)?p.technologies.map(x=>t(x).slice(0,40)).filter(Boolean).slice(0,20):[],visible:p.visible!==false,details:t(p.details).slice(0,2000)}}
function safeImage(v){const x=String(v??"").trim();if(/^data:image\/(jpeg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(x)&&x.length<=1800000)return x;return safeUrl(x)}
function safeUrl(v){if(!v)return"";try{const u=new URL(String(v));return["https:","http:"].includes(u.protocol)?u.href.slice(0,1000):""}catch{return""}}
function corsHeaders(origin){return{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET,POST,PUT,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization","Access-Control-Max-Age":"86400","Vary":"Origin"}}
function json(data,status,origin,extra={}){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8",...corsHeaders(origin),...extra}})}
function equal(a,b){if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0}
async function makeToken(secret,ttl){const p=b64url(btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+ttl,nonce:crypto.randomUUID()})));return p+"."+await sign(p,secret)}
async function verifyToken(token,secret){if(!token||!secret)return false;const a=token.split(".");if(a.length!==2||!equal(a[1],await sign(a[0],secret)))return false;try{return JSON.parse(atob(a[0].replace(/-/g,"+").replace(/_/g,"/"))).exp>Math.floor(Date.now()/1000)}catch{return false}}
async function sign(value,secret){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64url(btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value))))))}
function b64url(s){return s.replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")}
