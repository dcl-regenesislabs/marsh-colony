import {chromium} from 'playwright'; import http from 'http'; import fs from 'fs'; import path from 'path';
const types={'.html':'text/html','.js':'text/javascript','.glb':'model/gltf-binary','.png':'image/png'};
const srv=http.createServer((q,s)=>{const p='.'+decodeURIComponent(q.url.split('?')[0]); if(!fs.existsSync(p)){s.statusCode=404;return s.end()} s.setHeader('content-type',types[path.extname(p)]||'application/octet-stream'); fs.createReadStream(p).pipe(s)}).listen(8765);
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}); const pg=await b.newPage();
pg.on('console',m=>console.log('>',m.text())); pg.on('pageerror',e=>console.log('ERR',e.message));
await pg.goto('http://localhost:8765/render.html'); await pg.waitForFunction('window.ready');
const [yaw,anim,t,only]=[+(process.env.YAW??0.5),process.env.ANIM??'Idle',+(process.env.T??0.3),process.env.ONLY];
const OUT=process.env.OUT||'out';
for(const rar of (process.env.RARITY||'common,rare,legendary').split(',')){ fs.mkdirSync(`${OUT}/${rar}`,{recursive:true});
for(const fam of ['sprout','pepito','amebita','fluflito']) for(const f of fs.readdirSync('assets/Models/creatures/'+fam)){
  if(only && !f.startsWith(only)) continue;
  const url=await pg.evaluate(([u,b,y,a,t,r])=>renderCreature(u,b,y,a,t,r),[`/assets/Models/creatures/${fam}/${f}`,fam,yaw,anim,t,rar]);
  fs.writeFileSync(`${OUT}/${rar}/${f.replace('.glb','.png')}`,Buffer.from(url.split(',')[1],'base64')); console.log('ok',rar,f);
}}
await b.close(); srv.close();
