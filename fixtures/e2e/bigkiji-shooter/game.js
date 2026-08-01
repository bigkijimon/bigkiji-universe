import * as THREE from './vendor/three.module.js';

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#151c19'); scene.fog = new THREE.Fog('#151c19', 16, 34);
const camera = new THREE.PerspectiveCamera(50, 1, .1, 80); camera.position.set(0, 13, 14); camera.lookAt(0,0,0);
scene.add(new THREE.HemisphereLight('#dfe9df','#243027',2.3));
const sun = new THREE.DirectionalLight('#ffe4ca',3); sun.position.set(-5,12,6); sun.castShadow=true; scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(22,64),new THREE.MeshStandardMaterial({color:'#526756',roughness:.9}));
ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);
for(let i=0;i<54;i++){const blade=new THREE.Mesh(new THREE.ConeGeometry(.045,.4+Math.random()*.35,5),new THREE.MeshStandardMaterial({color:i%3?'#76927b':'#9baa84'}));const a=Math.random()*Math.PI*2,r=3+Math.random()*18;blade.position.set(Math.cos(a)*r,.2,Math.sin(a)*r);scene.add(blade);}

function cat(){const g=new THREE.Group(), fur=new THREE.MeshStandardMaterial({color:'#c88c58',roughness:.7}), dark=new THREE.MeshStandardMaterial({color:'#4d3a30'}), cream=new THREE.MeshStandardMaterial({color:'#e5c8a6'});
  const body=new THREE.Mesh(new THREE.SphereGeometry(.58,20,14),fur);body.scale.set(.9,1.2,.75);body.position.y=.68;body.castShadow=true;g.add(body);
  const head=new THREE.Mesh(new THREE.SphereGeometry(.48,20,14),fur);head.position.set(0,1.45,0);head.castShadow=true;g.add(head);
  for(const x of [-.28,.28]){const ear=new THREE.Mesh(new THREE.ConeGeometry(.18,.42,3),fur);ear.position.set(x,1.85,0);ear.rotation.z=x<0?.14:-.14;g.add(ear);const eye=new THREE.Mesh(new THREE.SphereGeometry(.045,10,8),dark);eye.position.set(x*.58,1.52,.44);g.add(eye);}
  const muzzle=new THREE.Mesh(new THREE.SphereGeometry(.16,12,8),cream);muzzle.scale.set(1.25,.65,.65);muzzle.position.set(0,1.32,.43);g.add(muzzle);
  const tail=new THREE.Mesh(new THREE.TorusGeometry(.48,.08,8,24,Math.PI*1.3),fur);tail.rotation.set(Math.PI/2,.2,-.5);tail.position.set(-.48,.78,-.22);g.add(tail);return g;}
const player=cat();scene.add(player);
const keys=new Set(), bullets=[], enemies=[];let running=false,score=0,health=100,lastSpawn=0,lastShot=0;const aim=new THREE.Vector3(0,0,-1),ray=new THREE.Raycaster(),mouse=new THREE.Vector2();
function enemy(){const e=new THREE.Mesh(new THREE.IcosahedronGeometry(.45,1),new THREE.MeshStandardMaterial({color:'#7d647b',emissive:'#332435',emissiveIntensity:.4,roughness:.6}));const a=Math.random()*Math.PI*2;e.position.set(Math.cos(a)*15,.5,Math.sin(a)*15);e.castShadow=true;e.userData.hp=2;scene.add(e);enemies.push(e);}
function shoot(){if(!running||performance.now()-lastShot<180)return;lastShot=performance.now();const b=new THREE.Mesh(new THREE.SphereGeometry(.09,8,6),new THREE.MeshBasicMaterial({color:'#ffd19c'}));b.position.copy(player.position).add(new THREE.Vector3(0,1.1,0));b.userData.v=aim.clone().setY(0).normalize().multiplyScalar(12);scene.add(b);bullets.push(b);}
function point(clientX,clientY){const r=canvas.getBoundingClientRect();mouse.set((clientX-r.left)/r.width*2-1,-((clientY-r.top)/r.height)*2+1);ray.setFromCamera(mouse,camera);const hit=new THREE.Vector3();if(ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),hit)){aim.copy(hit).sub(player.position).setY(0).normalize();player.rotation.y=Math.atan2(aim.x,aim.z);}}
addEventListener('keydown',e=>{keys.add(e.key.toLowerCase());if(e.code==='Space'){e.preventDefault();shoot();}});addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));canvas.addEventListener('pointermove',e=>point(e.clientX,e.clientY));canvas.addEventListener('pointerdown',e=>{point(e.clientX,e.clientY);shoot();});document.getElementById('fire').addEventListener('pointerdown',shoot);
const pad=document.getElementById('pad');let touchMove=new THREE.Vector2();function movePad(e){const r=pad.getBoundingClientRect(),x=e.clientX-r.left-r.width/2,y=e.clientY-r.top-r.height/2,l=Math.hypot(x,y)||1,s=Math.min(28,l);touchMove.set(x/l*s/28,y/l*s/28);pad.style.setProperty('--x',`${touchMove.x*28}px`);pad.style.setProperty('--y',`${touchMove.y*28}px`);}pad.addEventListener('pointerdown',e=>{pad.setPointerCapture(e.pointerId);movePad(e)});pad.addEventListener('pointermove',e=>{if(pad.hasPointerCapture(e.pointerId))movePad(e)});pad.addEventListener('pointerup',()=>{touchMove.set(0,0);pad.style.setProperty('--x','0px');pad.style.setProperty('--y','0px')});
function begin(){running=true;score=0;health=100;document.getElementById('intro').hidden=true;document.getElementById('restart').hidden=true;for(const e of enemies.splice(0))scene.remove(e);for(const b of bullets.splice(0))scene.remove(b);for(let i=0;i<4;i++)enemy();updateHud();}document.getElementById('start').onclick=begin;document.getElementById('restart').onclick=begin;
function updateHud(){document.getElementById('score').textContent=score;document.getElementById('health').textContent=Math.max(0,health);}
const clock=new THREE.Clock();function loop(){requestAnimationFrame(loop);const dt=Math.min(.04,clock.getDelta());if(running){const v=new THREE.Vector3((keys.has('d')||keys.has('arrowright')?1:0)-(keys.has('a')||keys.has('arrowleft')?1:0)+touchMove.x,0,(keys.has('s')||keys.has('arrowdown')?1:0)-(keys.has('w')||keys.has('arrowup')?1:0)+touchMove.y);if(v.lengthSq())player.position.addScaledVector(v.normalize(),dt*5);if(player.position.length()>12)player.position.setLength(12);
    if(performance.now()-lastSpawn>1500&&enemies.length<12){lastSpawn=performance.now();enemy();}
    for(const b of [...bullets]){b.position.addScaledVector(b.userData.v,dt);if(b.position.length()>24){bullets.splice(bullets.indexOf(b),1);scene.remove(b);continue;}for(const e of [...enemies])if(b.position.distanceTo(e.position)<.55){e.userData.hp--;bullets.splice(bullets.indexOf(b),1);scene.remove(b);if(e.userData.hp<=0){enemies.splice(enemies.indexOf(e),1);scene.remove(e);score+=10;updateHud();}break;}}
    for(const e of enemies){const d=player.position.clone().sub(e.position);e.position.addScaledVector(d.normalize(),dt*(1.15+score/250));e.rotation.y+=dt*2;if(e.position.distanceTo(player.position)<.8){health-=18;updateHud();e.position.multiplyScalar(1.35);if(health<=0){running=false;document.getElementById('restart').hidden=false;}}}}
  camera.position.x+=(player.position.x-camera.position.x)*dt*1.7;camera.position.z+=(player.position.z+14-camera.position.z)*dt*1.7;camera.lookAt(player.position.x,0,player.position.z);renderer.render(scene,camera);}loop();
function resize(){const w=canvas.clientWidth,h=canvas.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}addEventListener('resize',resize);resize();
