import * as THREE from 'three/webgpu';
import { pass, mrt, output, diffuseColor, normalView, vec3, vec4, mix, uniform } from 'three/tsl';
import { ao as ambientOcclusion } from 'three/addons/tsl/display/GTAONode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
// One published revision includes relative modules and local assets; editing files alone does not replace a running scene.
async function publishedScene() {
  const response=await fetch('/api/scene-update',{cache:'no-store'});
  if(!response.ok)throw Error('场景更新服务不可用');
  return response.json();
}
const revisionBase=revision=>'/.scene-updates/'+revision.revision+'/';
let activeRevision=await publishedScene().catch(()=>null);
let config=(await import(activeRevision?revisionBase(activeRevision)+activeRevision.entry:'./scene.js')).default;
import { createFurnitureEditor } from './furniture-editor.js';
import { createFurnitureCandidates } from './furniture-candidates.js';
import { createAnnotations } from './annotations.js';
import { timesOfDay, applyTimeOfDay } from './lighting.js';

const $ = selector => document.querySelector(selector);
const picture = $('#picture'), status = $('#status');
const stats = window.studioStats = { threeRevision: THREE.REVISION, phase: 'initializing', renderedFrames: 0, loadHistory: [], sceneVersion: 0 };
let timeOfDay=config.timeOfDay??'noon';
if(!Object.hasOwn(timesOfDay,timeOfDay))throw Error('Unknown time of day: '+timeOfDay);
$('#time-of-day').replaceChildren(...Object.entries(timesOfDay).map(([id,preset])=>new Option(preset.label,id)));
$('#time-of-day').value=timeOfDay;
function showError(caught) {
  stats.error = String(caught); stats.phase = 'error';
  status.textContent = model ? '加载失败，保留上一场景' : '查看器未就绪';
  $('#error small').textContent = String(caught.message || caught);
  $('#error').hidden = Boolean(model);
  console.error(caught);
}
const scene = new THREE.Scene();
scene.background = new THREE.Color(config.background || '#ece8da');
const renderer = new THREE.WebGPURenderer({ antialias: true, samples: 4 });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = config.exposure ?? 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;
picture.prepend(renderer.domElement);
let model = null;
try {
  if (!isSecureContext || !navigator.gpu) throw new Error('此浏览器未提供 WebGPU；请在支持 WebGPU 的浏览器中使用 localhost 或 HTTPS。');
  await renderer.init();
  stats.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  if (stats.backend !== 'webgpu') throw new Error('WebGPU 初始化失败，实际回退为 WebGL2。此项目要求 WebGPU，请检查浏览器 GPU 设置。');
} catch (caught) { showError(caught); throw caught; }
THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
const camera = new THREE.PerspectiveCamera(44, 1, .05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = .08;
controls.maxPolarAngle = Math.PI * .49;
const roomEnvironment = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = pmrem.fromScene(roomEnvironment, .045);
scene.environment = environment.texture;
scene.environmentIntensity = config.environmentIntensity ?? .5;
roomEnvironment.dispose(); pmrem.dispose();
const quality = { maxDpr: 1.5, interactionPixels: 900, settleMs: 180, aoRadius: .15, aoStrength: .34, ...config.quality };
const scenePass = pass(scene, camera, { samples: 4 });
scenePass.setMRT(mrt({ output, normal: normalView, diffuseColor }));
scenePass.getTexture('diffuseColor').type = THREE.UnsignedByteType;
const color = scenePass.getTextureNode('output');
const albedo = scenePass.getTextureNode('diffuseColor');
const depth = scenePass.getTextureNode('depth'), normal = scenePass.getTextureNode('normal');
const gtao = ambientOcclusion(depth, normal, camera);
gtao.resolutionScale = .5; gtao.samples.value = 16;
gtao.radius.value = quality.aoRadius; gtao.thickness.value = .12;
gtao.useTemporalFiltering = false;
const softenedAO = denoise(gtao.getTextureNode(), depth, normal, camera);
softenedAO.radius.value = 8;
softenedAO.lumaPhi.value = 8; softenedAO.depthPhi.value = 2; softenedAO.normalPhi.value = 2;
const aoStrength=uniform(quality.aoStrength);
const shaded = color.mul(vec4(vec3(mix(1, softenedAO.r, aoStrength)), 1));
const indirect = ssgi(color, depth, normal, camera);
indirect.sliceCount.value=2;indirect.stepCount.value=6;
indirect.radius.value=1.6;indirect.thickness.value=.22;indirect.giIntensity.value=1;
// Deterministic spatial filtering: one settled frame, no accumulation loop while idle.
indirect.useTemporalFiltering=false;
const softGI=denoise(indirect.getGINode(),depth,normal,camera);
const softGIAO=denoise(indirect.getAONode(),depth,normal,camera);
for(const filter of [softGI,softGIAO]){filter.radius.value=6;filter.lumaPhi.value=8;filter.depthPhi.value=2;filter.normalPhi.value=2;}
const giAO=uniform(quality.aoStrength);
const bounced=vec4(color.rgb.mul(mix(1,softGIAO.r,giAO)).add(albedo.rgb.mul(softGI.rgb)),color.a);
const pipeline = new THREE.RenderPipeline(renderer, shaded);
// RenderPipeline applies tone mapping and output conversion exactly once.
const ao = { enabled: true };
let indirectEnabled=true,effectMode='ao';
function setEffects(detailed) {
  ao.enabled = contactShadows && detailed;
  giAO.value = ao.enabled ? quality.aoStrength : 0;
  const mode = detailed && indirectEnabled ? 'gi' : ao.enabled ? 'ao' : 'direct';
  stats.lighting={mode,indirectEnabled,contactShadows:ao.enabled,temporalAccumulation:false};
  if (effectMode === mode) return;
  effectMode=mode;
  pipeline.outputNode = mode==='gi' ? bounced : mode==='ao' ? shaded : color;
  pipeline.needsUpdate = true;
}
const draco = new DRACOLoader().setDecoderPath('./node_modules/three/examples/jsm/libs/draco/').setWorkerLimit(2);
let content=null;
const reflectionTargets=new WeakMap();
let cutawayEnabled = true, cutawayParts = [], cutawayKey = '';
let needsRender = true, lastMovement = 0, detailedMode = true;
let exporting = false, loading = false, disposed = false, contactShadows = true;
let loadToken = 0, loadQueue = Promise.resolve(), exportJob = Promise.resolve();
let views = config.views || {}, bounds;
let annotations=null,candidates=null;
const invalidate = () => { needsRender = true;annotations?.markDirty(); };
function invalidateShadows() {
  scene.traverse(object => {
    if (object.isLight && object.castShadow) {
      object.shadow.autoUpdate = false;
      object.shadow.needsUpdate = true;
    }
  });
  invalidate();
}
const editor=createFurnitureEditor({scene,camera,canvas:renderer.domElement,orbit:controls,invalidate,selectionChanged:object=>candidates?.select(object),moved(){onChange();invalidateShadows();}});
annotations=createAnnotations({scene,camera,canvas:renderer.domElement,controls,editor,config,invalidate,exportPNG,loadScene,setView,isBusy:()=>loading||exporting||disposed||!model});
candidates=createFurnitureCandidates({host:picture,load:loadCandidate,disposeModel,commit:commitCandidate,invalidate});
function updateCutaway() {
  if (!bounds) return;
  const center = bounds.getCenter(new THREE.Vector3());
  const xWall = camera.position.x < center.x ? 'west' : 'east';
  const zWall = camera.position.z > center.z ? 'south' : 'north';
  const hideCeiling = cutawayEnabled && camera.position.y > bounds.max.y;
  const legacyHiddenWalls = [];
  if (cutawayEnabled) {
    if (hideCeiling || camera.position.x < bounds.min.x || camera.position.x > bounds.max.x) legacyHiddenWalls.push(xWall);
    if (hideCeiling || camera.position.z < bounds.min.z || camera.position.z > bounds.max.z) legacyHiddenWalls.push(zWall);
  }
  const hidden = cutawayParts.map(object => {
    if (!cutawayEnabled) return false;
    const data = object.userData;
    if (data.cutaway_ceiling || data.cutaway_partition) return hideCeiling;
    if (data.cutaway_plane) {
      const { normal: [nx, nz], point: [x, z] } = data.cutaway_plane;
      const cameraSide = (camera.position.x - x) * nx + (camera.position.z - z) * nz;
      const targetSide = (controls.target.x - x) * nx + (controls.target.z - z) * nz;
      // Eye-level views only remove an exterior face between the camera and its target.
      return cameraSide > .02 && (hideCeiling || targetSide <= 0);
    }
    return legacyHiddenWalls.includes(data.cutaway_wall);
  });
  const key = `${cutawayEnabled}:${hideCeiling}:${hidden.map(Number).join('')}`;
  if (key === cutawayKey) return;
  cutawayKey = key;
  const hiddenWalls = new Set();
  let visibilityChanged = false, hiddenParts = 0, partitionsLowered = 0;
  cutawayParts.forEach((object, index) => {
    const hide = hidden[index];
    if (object.visible === hide) { object.visible = !hide; visibilityChanged = true; }
    if (!hide) return;
    hiddenParts++;
    if (object.userData.cutaway_wall) hiddenWalls.add(object.userData.cutaway_wall);
    if (object.userData.cutaway_partition) partitionsLowered++;
  });
  if (visibilityChanged) invalidateShadows();
  stats.cutaway = { enabled: cutawayEnabled, hiddenWalls: [...hiddenWalls], ceilingHidden: hideCeiling, parts: cutawayParts.length, hiddenParts, partitionsLowered };
  editor.refreshVisibility();
}
function setView(view = Object.keys(views)[0]) {
  clearCameraKeys();
  const preset = views[view];
  if (view === 'orbit') controls.enableRotate = true;
  if (preset) {
    camera.position.fromArray(preset.position); controls.target.fromArray(preset.target);
    camera.fov = preset.fov || 44;
    controls.enableRotate = preset.rotate !== false;
    camera.updateProjectionMatrix(); controls.update(); resize();
  }
  $('#view').value = view;
  updateCutaway(); invalidate();
}
function configureModel(definition,keepCamera=false) {
  const modelBounds = new THREE.Box3();
  for(const child of model.children)if(!child.userData.candidateStorage)modelBounds.union(new THREE.Box3().setFromObject(child,true));
  const room = definition.roomBounds || config.roomBounds;
  bounds = room ? new THREE.Box3(new THREE.Vector3(...room.min), new THREE.Vector3(...room.max)) : modelBounds;
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, .1);
  camera.near = Math.max(.001, radius / 1000); camera.far = radius * 30;
  controls.minDistance = radius / 20; controls.maxDistance = radius * 6;
  views = definition.views || config.views || {
    dollhouse: { label: '整体视角', position: center.clone().add(new THREE.Vector3(radius, radius, radius * 1.3)).toArray(), target: center.toArray() },
    plan: { label: '平面俯视', position: center.clone().add(new THREE.Vector3(0, radius * 2, .001)).toArray(), target: center.toArray(), rotate: false },
  };
  $('#view').replaceChildren(...Object.entries(views).map(([id, preset]) => new Option(preset.label || id, id)), new Option('自由视角', 'orbit'));
  const sun = scene.getObjectByName('Default key light');
  if (sun) {
    sun.position.copy(center).add(new THREE.Vector3(-radius, radius * 2, radius)); sun.target.position.copy(center);
    Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: .01, far: radius * 8 });
    sun.shadow.camera.updateProjectionMatrix();
  }
  const indoor=scene.getObjectByName('Default indoor light');
  if(indoor){indoor.position.copy(center).add(new THREE.Vector3(0,radius*.6,-radius*.25));indoor.intensity=Math.max(2,radius*radius*.22);}
  cutawayParts = [];
  scene.traverse(object => {
    const data = object.userData;
    if (data.cutaway_wall || data.cutaway_ceiling || data.cutaway_plane || data.cutaway_partition) cutawayParts.push(object);
  });
  $('#cutaway').disabled = !cutawayParts.length;
  cutawayKey = ''; if(!keepCamera)setView();else {camera.updateProjectionMatrix();updateCutaway();} invalidateShadows();
}
function resize() {
  if (exporting || disposed) return;
  const stage = picture.parentElement.getBoundingClientRect();
  const {width,height}=stage;
  if (!width || !height) return;
  camera.aspect = width / height; camera.updateProjectionMatrix();
  const ratio = detailedMode ? Math.min(devicePixelRatio, quality.maxDpr) : Math.min(devicePixelRatio, 1, quality.interactionPixels / Math.max(width, height));
  renderer.setPixelRatio(ratio); renderer.setSize(width, height, false);
  stats.renderSize = [renderer.domElement.width, renderer.domElement.height];
  stats.devicePixelRatio = ratio; invalidate();
}
function drawFrame() {
  const target=renderer.getRenderTarget(),mrt=renderer.getMRT();
  renderer.info.reset();
  try {pipeline.render();}finally {renderer.setRenderTarget(target);renderer.setMRT(mrt);}
  stats.drawCalls = renderer.info.render.drawCalls;
  stats.renderedTrianglesIncludingPasses = renderer.info.render.triangles;
  stats.renderedFrames++;
}
function disposeModel(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set(), targets=new Set();
  root.traverse(object => {
    const reflection=reflectionTargets.get(object);if(reflection){targets.add(reflection);reflectionTargets.delete(object);}
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [object.material].flat().filter(Boolean)) materials.add(material);
    if (object.skeleton) object.skeleton.dispose();
    if (object.isLight) object.dispose();
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for(const target of targets){textures.delete(target.texture);target.dispose();}
  for (const texture of textures) { texture.dispose(); if (texture.source.data?.close) texture.source.data.close(); }
  for (const geometry of geometries) geometry.dispose();
}
function bindReflection(root,target) {
  if(target)reflectionTargets.set(root,target);else reflectionTargets.delete(root);
  root.traverse(object=>{for(const material of [object.material].flat().filter(Boolean))if(material.metalness>.5){
    const nextMap=target?.texture??null;
    // Keep the same probe texture for the lifetime of this scene; WebGPU caches its material binding.
    if(material.envMap!==nextMap){material.envMap=nextMap;material.needsUpdate=true;}
    material.envMapIntensity=1;
  }});
}
function prepareReflections(root,furniture,settings) {
  if(!settings.reflectionPosition)return;
  const probe=new THREE.Scene(),generator=new THREE.PMREMGenerator(renderer);
  const preset=timesOfDay[timeOfDay];
  probe.background=new THREE.Color(preset.background);probe.environment=environment.texture;probe.environmentIntensity=(settings.environmentIntensity??.5)*preset.environment;
  const target=renderer.getRenderTarget(),mrt=renderer.getMRT();
  const visible=furniture.visible,parent=root.parent,hidden=[],metalMaps=new Map();
  root.updateWorldMatrix(true,true);
  // Lights remain in the room probe even when their furniture meshes are excluded.
  furniture.traverseVisible(object=>{if(object.isLight&&!object.target){const light=object.clone();light.position.copy(object.getWorldPosition(new THREE.Vector3()));probe.add(light);}});
  root.traverse(object=>{
    const data=object.userData;
    if(!object.visible&&(data.cutaway_wall||data.cutaway_plane||data.cutaway_ceiling||data.cutaway_partition)){hidden.push(object);object.visible=true;}
    for(const material of [object.material].flat().filter(Boolean))if(material.metalness>.5&&!metalMaps.has(material)){metalMaps.set(material,material.envMap);material.envMap=null;}
  });
  // ponytail: a static room-shell probe, not a dynamic mirror of movable furniture.
  // Rebuild on scene or time changes; moving a chair never starts six extra renders.
  let reflection;
  try {
    furniture.visible=false;probe.add(root);renderer.setMRT(null);
    reflection=generator.fromScene(probe,.035,.1,50,{size:128,position:new THREE.Vector3(...settings.reflectionPosition),renderTarget:reflectionTargets.get(root)??null});
  } finally {
    root.removeFromParent();parent?.add(root);furniture.visible=visible;hidden.forEach(object=>object.visible=false);
    for(const [material,map] of metalMaps)material.envMap=map;
    probe.traverse(object=>{if(object.isLight)object.dispose();});
    generator.dispose();renderer.setRenderTarget(target);renderer.setMRT(mrt);
  }
  bindReflection(root,reflection);
  stats.reflectionUpdates=(stats.reflectionUpdates||0)+1;
}
async function readAssets(definition,loader) {
  const incoming = new THREE.Group(), templates = new Map();
  const assets=definition.assets || [{url:definition.url}],placements=new Map();
  try {
    for (const asset of assets) {
      if (!asset.url) throw new Error('场景缺少 GLB / glTF 路径');
      if (!templates.has(asset.url)) templates.set(asset.url, (await loader.loadAsync(asset.url)).scene);
      const object = clone(templates.get(asset.url));
      // A wrapper preserves the original glTF root transform and coordinate system.
      const placement = new THREE.Group(); placement.add(object);
      if (asset.position) placement.position.fromArray(asset.position);
      if (asset.rotation) placement.rotation.fromArray(asset.rotation);
      if (asset.scale != null) Array.isArray(asset.scale) ? placement.scale.fromArray(asset.scale) : placement.scale.setScalar(asset.scale);
      placement.name = asset.name || asset.url;
      placement.userData.annotation={id:'asset:'+placement.name,label:asset.editable||asset.name||asset.url,source:asset.url,...asset.annotation};
      incoming.add(placement);
      if(placements.has(placement.name))throw new Error('同一方案的家具名称须唯一：'+placement.name);
      placements.set(placement.name,placement);
      if(asset.editable) {
        if(!asset.name || typeof asset.editable!=='string' || asset.attachTo)throw new Error('可编辑家具需要唯一 name 和 editable 显示名称，并作为独立根对象');
        const body=new THREE.Group();body.name=asset.name+' · authored body';body.scale.copy(placement.scale);
        body.add(object);placement.scale.setScalar(1);placement.add(body);
        placement.userData.editableLabel=asset.editable;
      }
    }
    // One editable root owns its attached props. Unit scale keeps them rigid during rotation.
    incoming.updateMatrixWorld(true);
    for(const asset of assets)if(asset.attachTo) {
      const parent=placements.get(asset.attachTo);
      if(!parent?.userData.editableLabel)throw new Error('attachTo 必须指向本方案的可编辑家具：'+asset.attachTo);
      parent.attach(placements.get(asset.name||asset.url));
    }
    return incoming;
  } catch (caught) { disposeModel(incoming); throw caught; }
}
function applySceneSettings() {
  const preset=timesOfDay[timeOfDay];
  scene.background.set(preset.background);scene.environmentIntensity=(config.environmentIntensity??.5)*preset.environment;renderer.toneMappingExposure=(config.exposure??1)*preset.exposure;
  $('#time-of-day').value=timeOfDay;stats.timeOfDay={id:timeOfDay,label:preset.label};
  Object.assign(quality,{maxDpr:1.5,interactionPixels:900,settleMs:180,aoRadius:.15,aoStrength:.34},config.quality);
  gtao.radius.value=quality.aoRadius;aoStrength.value=quality.aoStrength;
}
function cameraState() {
  return {position:camera.position.clone(),target:controls.target.clone(),fov:camera.fov,rotate:controls.enableRotate,view:$('#view').value};
}
function restoreCamera(saved) {
  camera.position.copy(saved.position);controls.target.copy(saved.target);camera.fov=saved.fov;controls.enableRotate=saved.rotate;
  camera.updateProjectionMatrix();controls.update();$('#view').value=saved.view;updateCutaway();
}
function sceneLoader(revision) {
  const manager=new THREE.LoadingManager(),errors=[];
  let pending=0,done;
  const start=manager.itemStart.bind(manager),end=manager.itemEnd.bind(manager);
  manager.itemStart=url=>{pending++;start(url);};
  manager.itemEnd=url=>{end(url);if(--pending===0){done?.();done=null;}};
  manager.onError=url=>errors.push(url);
  if(revision)manager.setURLModifier(value=>{
    const url=new URL(value,document.baseURI);
    if(!['http:','https:'].includes(url.protocol)||url.origin!==location.origin||url.pathname.startsWith('/.scene-updates/')||url.pathname.includes('/node_modules/'))return value;
    return revisionBase(revision)+url.pathname.slice(1)+url.search;
  });
  return {manager,loader:new GLTFLoader(manager).setDRACOLoader(draco),async settled(){
    if(pending)await new Promise(resolve=>{done=resolve;});
    if(errors.length)throw Error('资源加载失败：'+errors.slice(0,3).join(', ')+(errors.length>3?' 等 '+errors.length+' 项':''));
  }};
}
const syncButton=document.createElement('button');syncButton.id='scene-sync';syncButton.textContent='实时更新';syncButton.title='保持当前机位，接收已提交的场景；点击重试';$('.tools').append(syncButton);
let lastAttempt=activeRevision?.revision,updateChecking=false;
function syncStatus(phase,revision,error=null) {
  stats.liveUpdate={phase,revision:revision?.revision||null,appliedRevision:activeRevision?.revision||null,error:error?String(error):null};
  syncButton.textContent=({preparing:'准备更新…',waiting:'更新待应用',applying:'应用更新…',ready:'已同步',error:'更新失败 · 重试',offline:'等待连接'})[phase]||'实时更新';
  syncButton.title=error?String(error):'保留机位、评论和无关家具的调整；点击检查更新';
}
const commitBusy=()=>annotations.composing||editor.state.dragging||exporting||(typing(document.activeElement)&&document.activeElement!==$('#time-of-day'))||cameraKeys.size||orbitGesture||document.hidden;
async function checkSceneUpdate({retry=false}={}) {
  if(updateChecking||disposed)return;
  updateChecking=true;
  try {
    const revision=await publishedScene();
    if(!revision||revision.revision===activeRevision?.revision||(!retry&&revision.revision===lastAttempt))return;
    lastAttempt=revision.revision;syncStatus('preparing',revision);
    const next=(await import(revisionBase(revision)+revision.entry)).default;
    if(!Array.isArray(next?.scenes)||!next.scenes.length||new Set(next.scenes.map(s=>s.id)).size!==next.scenes.length)throw Error('新场景需要唯一的方案 ID');
    // Keep the existing config as the source of ordinary layout switches until commit succeeds.
    const result=await loadScene(stats.currentScene,{nextConfig:next,revision,live:true});
    if(!result)lastAttempt=null; // A user layout switch superseded preparation; retry against that layout.
  } catch(error) {syncStatus('error',{revision:lastAttempt},error);}
  finally {updateChecking=false;}
}
syncButton.onclick=()=>checkSceneUpdate({retry:true});
function loadScene(definition,{nextConfig=config,revision=activeRevision,live=false}={}) {
  if(!live&&annotations?.composing)return Promise.reject(new Error('请先保存或取消正在编写的评论'));
  if(!live)clearCameraKeys();
  const token=++loadToken;
  // One scene owner and one queue; staging coexists with the current content only until commit.
  const operation=loadQueue.then(async()=>{
    if(token!==loadToken||disposed)return;
    if(!live){nextConfig=config;revision=activeRevision;} // Resolve queued layout choices against the version that actually committed.
    if(typeof definition==='string')definition=nextConfig.scenes.find(item=>item.id===definition||item.url===definition);
    if(!definition)throw Error('更新中缺少正在查看的方案；保留当前场景');
    if(!live){loading=true;editor.setBusy(true);stats.phase='loading';status.textContent=`正在打开 ${definition.label||definition.id}…`;}
    const began=performance.now(),resources=sceneLoader(revision),incomingContent=new THREE.Group();
    let incoming,committed=false,previous=content,previousModel=model,oldConfig=config;
    let savedCamera,savedEditor,oldDefinition,selected;
    try {
      if(nextConfig.setup)await nextConfig.setup(incomingContent,{manager:resources.manager});
      else {
        const sun=new THREE.DirectionalLight('#fff1da',3);sun.name='Default key light';sun.castShadow=true;
        sun.shadow.mapSize.set(2048,2048);sun.shadow.normalBias=.02;
        const indoor=new THREE.PointLight('#ffd3a3',2);indoor.name='Default indoor light';
        incomingContent.add(sun,sun.target,indoor,new THREE.HemisphereLight('#fff6e4','#a89b80',.3));
      }
      incoming=await readAssets(definition,resources.loader);incomingContent.add(incoming);
      const decoded=performance.now();let meshes=0,triangles=0;
      incoming.traverse(object=>{
        if(object.isLight||object.isCamera)object.visible=false;
        if(!object.isMesh)return;
        object.castShadow=true;object.receiveShadow=true;meshes++;triangles+=(object.geometry.index?.count||object.geometry.attributes.position.count)/3;
        for(const material of [object.material].flat())for(const value of Object.values(material))if(value?.isTexture)value.anisotropy=Math.min(8,renderer.getMaxAnisotropy());
      });
      if(nextConfig.prepare)await nextConfig.prepare(incoming,definition,{manager:resources.manager});
      incoming.traverse(object=>{if(object.userData.annotation&&object.userData.editableLabel)object.userData.annotation.label=object.userData.editableLabel;});
      await candidates.prepare(incoming,definition,revision,url=>resources.manager.resolveURL(url));
      await resources.settled();
      if(live) {
        syncStatus('waiting',revision);
        while(commitBusy()&&token===loadToken&&!disposed)await new Promise(resolve=>setTimeout(resolve,100));
      }
      await exportJob.catch(()=>{});
      if(token!==loadToken||disposed)return;
      // Compile and swap use the same renderer. Keep its last image visible while this short critical section runs.
      savedCamera=cameraState();savedEditor=editor.session;selected=editor.state.selected;
      oldDefinition=config.scenes.find(item=>item.id===stats.currentScene);
      loading=true;clearCameraKeys();editor.setBusy(true);$('#export').disabled=true;
      const commitBegan=performance.now();
      if(live)syncStatus('applying',revision);
      config=nextConfig;applySceneSettings();
      previous?.removeFromParent();scene.add(incomingContent);content=incomingContent;model=incoming;committed=true;
      candidates.bind(model);editor.bindModel(model,definition.id);configureModel(definition,live);if(live)restoreCamera(savedCamera);
      applyTimeOfDay(content,timeOfDay,config);prepareReflections(content,model,config);invalidateShadows();
      stats.phase='compiling';
      await annotations.bind(definition);
      const prepared=performance.now();
      // r185 compileAsync serializes node builds: measured 40s here vs ~2s for the
      // native first draw. Keep the previous content until that draw succeeds.
      setEffects(false);drawFrame();setEffects(true);detailedMode=true;resize();drawFrame();
      if(previous){candidates.release(previousModel);disposeModel(previous);}
      const measurement={id:definition.id,networkAndDecodeMs:+(decoded-began).toFixed(1),scenePrepareMs:+(prepared-decoded).toFixed(1),totalLoadMs:+(performance.now()-began).toFixed(1),commitMs:+(performance.now()-commitBegan).toFixed(1),firstFrameSubmitMs:+(performance.now()-prepared).toFixed(1),meshes,triangles,msaaSamples:4};
      Object.assign(stats,measurement,{currentScene:definition.id,error:null,phase:'ready'});
      stats.sceneVersion++;stats.loadHistory.push(measurement);activeRevision=revision;renderLayouts();
      if(live){syncStatus('ready',revision);annotations.reload().catch(()=>{});}
      document.title=config.title||'WebGPU 场景';status.textContent=(editor.state.count?'点击家具调整 · ':'')+'WASD / 方向键移动镜头 · 拖动转视角 · 滚轮缩放';
      return measurement;
    } catch(error) {
      if(committed) {
        incomingContent.removeFromParent();content=previous;model=previousModel;config=oldConfig;
        applySceneSettings();
        editor.restoreSession(savedEditor);
        if(previous){scene.add(previous);candidates.bind(model);editor.bindModel(model,oldDefinition.id);configureModel(oldDefinition,true);applyTimeOfDay(content,timeOfDay,config);restoreCamera(savedCamera);await annotations.bind(oldDefinition);}
      }
      if(live){stats.phase=model?'ready':'error';throw error;}else showError(error);
    } finally {
      if(content!==incomingContent){if(incoming)candidates.release(incoming);await resources.settled().catch(()=>{});disposeModel(incomingContent);}
      loading=false;$('#export').disabled=!model;editor.setBusy(!model);
      if(live&&selected)editor.select(selected);invalidate();
    }
  });
  loadQueue=operation.catch(()=>{});return operation;
}
async function loadCandidate(option,revision) {
  const resources=sceneLoader(revision);let incoming;
  try {
    incoming=await readAssets({assets:[{url:option.url,name:option.id,position:option.offset,rotation:option.rotation,scale:option.scale}]},resources.loader);
    incoming.traverse(object=>{
      if(object.isLight||object.isCamera)object.visible=false;
      if(object.isMesh){object.castShadow=true;object.receiveShadow=true;
        for(const material of [object.material].flat())for(const value of Object.values(material))if(value?.isTexture)value.anisotropy=Math.min(8,renderer.getMaxAnisotropy());}
    });
    await resources.settled();return incoming;
  } catch(error){if(incoming)disposeModel(incoming);throw error;}
}
function setTimeOfDay(id) {
  if(!Object.hasOwn(timesOfDay,id))return Promise.reject(new Error('Unknown time of day: '+id));
  const operation=loadQueue.then(async()=>{
    await exportJob.catch(()=>{});
    while(commitBusy()&&!disposed)await new Promise(resolve=>setTimeout(resolve,50));
    if(disposed||!content)throw Error('Scene is not ready');
    if(timeOfDay===id){$('#time-of-day').value=id;return stats.timeOfDay;}
    const before=timeOfDay,busy=editor.state.busy,began=performance.now();
    loading=true;clearCameraKeys();editor.setBusy(true);$('#time-of-day').disabled=true;
    try {
      timeOfDay=id;applySceneSettings();applyTimeOfDay(content,id,config);prepareReflections(content,model,config);invalidateShadows();
      await new Promise(requestAnimationFrame);
      detailedMode=true;resize();setEffects(true);drawFrame();
      stats.timeOfDay={id,label:timesOfDay[id].label,switchMs:+(performance.now()-began).toFixed(1)};
      return stats.timeOfDay;
    } catch(error) {
      timeOfDay=before;applySceneSettings();applyTimeOfDay(content,before,config);prepareReflections(content,model,config);invalidateShadows();throw error;
    } finally {loading=false;editor.setBusy(busy);$('#time-of-day').disabled=false;invalidate();}
  });
  loadQueue=operation.catch(()=>{});return operation;
}
function commitCandidate(mutate) {
  const token=loadToken;
  const job=loadQueue.then(async()=>{
    await exportJob.catch(()=>{});
    while(commitBusy()&&token===loadToken&&!disposed)await new Promise(resolve=>setTimeout(resolve,50));
    if(token!==loadToken||disposed||!model)throw Error('场景已变化，请重新选择候选');
    const busy=editor.state.busy,definition=config.scenes.find(s=>s.id===stats.currentScene);
    loading=true;clearCameraKeys();editor.setBusy(true);let rollback;
    try {
      rollback=mutate();invalidateShadows();
      applyTimeOfDay(content,timeOfDay,config);await annotations.bind(definition);drawFrame();
      stats.lastCandidateChange={scene:definition.id,slot:editor.state.selected,at:new Date().toISOString()};
    } catch(error){if(rollback){rollback();await annotations.bind(definition);invalidateShadows();}throw error;}
    finally {loading=false;editor.setBusy(busy);invalidate();}
  });
  loadQueue=job.catch(()=>{});return job;
}
function exportPNG({ download = true, width = config.exportWidth || 1600 } = {}) {
  if (!model || exporting || loading || disposed) return Promise.reject(new Error('请等场景加载或导出完成'));
  if (!Number.isInteger(width) || width < 1 || width > 8192) return Promise.reject(new Error('PNG 宽度须为 1–8192 的整数'));
  const editorWasBusy=editor.state.busy;
  clearCameraKeys();annotations.setExporting(true);exporting = true; $('#export').disabled = true;editor.setBusy(true);
  const cameraEnabled=controls.enabled;controls.enabled=false;
  exportJob = (async () => {
    try {
      // PassNode is cached per animation frame; each export needs a fresh frame after changing views.
      await new Promise(resolve => requestAnimationFrame(resolve));
      const height = Math.round(width / camera.aspect);
      renderer.setPixelRatio(1); renderer.setSize(width, height, false); setEffects(true);
      drawFrame();
      // Call toBlob in the same task as render; never allow another frame to overwrite the canvas.
      const blob = await new Promise((resolve, reject) => renderer.domElement.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 导出失败')), 'image/png'));
      if (download) {
        const url = URL.createObjectURL(blob), anchor = document.createElement('a');
        anchor.download = `scene-${stats.currentScene}-${$('#view').value}.png`; anchor.href = url; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      stats.lastExport = { width, height, bytes: blob.size, scene:stats.currentScene, timeOfDay, view:$('#view').value, frame:renderer.info.frame, editingOverlaysHidden:!editor.state.overlaysVisible, at: new Date().toISOString() };
      return blob;
    } finally { exporting = false;annotations.setExporting(false); detailedMode = true;controls.enabled=cameraEnabled; resize(); $('#export').disabled = false;editor.setBusy(editorWasBusy); }
  })();
  // Keep the serialization barrier fulfilled while preserving the caller's rejection.
  exportJob.catch(() => {});
  return exportJob;
}
const observer = new ResizeObserver(resize); observer.observe(picture.parentElement);
const cameraKeys=new Set(),moveRight=new THREE.Vector3(),moveForward=new THREE.Vector3(),moveOffset=new THREE.Vector3();
const cameraKeyCodes=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowDown','ArrowRight']);
let cameraKeyTime=0;
const typing=element=>element?.matches?.('input,textarea,select')||element?.isContentEditable;
function clearCameraKeys(){cameraKeys.clear();cameraKeyTime=0;}
function cameraKeyDown(event) {
  if(event.ctrlKey||event.metaKey||event.altKey||event.isComposing||typing(event.target)||document.hidden||loading||exporting||disposed||!model||!controls.enabled||editor.state.busy){clearCameraKeys();return;}
  if(event.code==='Escape'){clearCameraKeys();return;}
  if(!cameraKeyCodes.has(event.code))return;
  // After blur or a paused interaction, an OS repeat must not restart a held key.
  if(event.repeat&&!cameraKeys.has(event.code))return;
  event.preventDefault();
  if(!cameraKeys.size)cameraKeyTime=performance.now();
  cameraKeys.add(event.code);
}
function cameraKeyUp(event){
  // Include the final partial frame, including taps shorter than one frame.
  if(cameraKeys.has(event.code))moveCameraWithKeys(performance.now());
  cameraKeys.delete(event.code);if(!cameraKeys.size)cameraKeyTime=0;
}
function cameraKeyFocus(event){if(typing(event.target))clearCameraKeys();}
function moveCameraWithKeys(time) {
  if(!controls.enabled||editor.state.busy){clearCameraKeys();return;}
  if(!cameraKeys.size)return;
  const dt=Math.max(0,Math.min((time-cameraKeyTime)/1000,.05));cameraKeyTime=time;
  const forward=Number(cameraKeys.has('KeyW')||cameraKeys.has('ArrowUp'))-Number(cameraKeys.has('KeyS')||cameraKeys.has('ArrowDown'));
  const right=Number(cameraKeys.has('KeyD')||cameraKeys.has('ArrowRight'))-Number(cameraKeys.has('KeyA')||cameraKeys.has('ArrowLeft'));
  if(!forward&&!right)return;
  camera.updateMatrixWorld();moveRight.setFromMatrixColumn(camera.matrixWorld,0);moveRight.y=0;moveRight.normalize();
  // The horizontal right axis also gives a stable heading in a straight-down plan view.
  moveForward.set(moveRight.z,0,-moveRight.x);
  moveOffset.copy(moveRight).multiplyScalar(right).addScaledVector(moveForward,forward).normalize().multiplyScalar((config.navigationSpeed??1.5)*dt);
  camera.position.add(moveOffset);controls.target.add(moveOffset);
  if(controls.enableRotate)$('#view').value='orbit';
  onChange();
}
window.addEventListener('keydown',cameraKeyDown);window.addEventListener('keyup',cameraKeyUp);
window.addEventListener('blur',clearCameraKeys);window.addEventListener('focusin',cameraKeyFocus);
function onVisibility() { clearCameraKeys();invalidate(); }
function onChange() { lastMovement = performance.now(); invalidate(); }
controls.addEventListener('change', onChange);
let orbitGesture=false;
controls.addEventListener('end',()=>{orbitGesture=false;});
controls.addEventListener('start', () => { orbitGesture=true;if (controls.enableRotate) $('#view').value = 'orbit'; });
document.addEventListener('visibilitychange', onVisibility);
$('#view').onchange = event => setView(event.target.value);
$('#time-of-day').onchange = event => setTimeOfDay(event.target.value).catch(error=>{status.textContent='时段切换失败，保留原光照：'+error.message;});
$('#cutaway').onclick = event => { cutawayEnabled = !cutawayEnabled; event.currentTarget.setAttribute('aria-pressed', String(cutawayEnabled)); updateCutaway(); };
$('#ao').onclick = event => { contactShadows = !contactShadows; event.currentTarget.setAttribute('aria-pressed', String(contactShadows)); invalidate(); };
$('#gi').onclick = event => { indirectEnabled = !indirectEnabled; event.currentTarget.setAttribute('aria-pressed', String(indirectEnabled)); invalidate(); };
$('#export').onclick = () => exportPNG().catch(showError);
function renderLayouts() {
  $('nav').replaceChildren(...config.scenes.map(definition=>{
    const button=document.createElement('button');button.textContent=definition.label||definition.id;
    button.dataset.layout=definition.id;button.setAttribute('aria-pressed',String(definition.id===stats.currentScene));
    button.onclick=()=>loadScene(definition.id);return button;
  }));
}
renderLayouts();
document.title = config.title || 'WebGPU 场景';
renderer.setAnimationLoop(time => {
  if (document.hidden || exporting || loading || disposed || !model) return;
  controls.update();moveCameraWithKeys(time); updateCutaway();annotations.update(time);
  const detailed = time - lastMovement > quality.settleMs;
  if (detailed !== detailedMode || devicePixelRatio !== stats.screenDpr) { detailedMode = detailed; stats.screenDpr = devicePixelRatio; resize(); }
  if (!needsRender) { stats.renderMode = 'idle'; return; }
  needsRender = false; setEffects(detailedMode);
  stats.renderMode = detailedMode ? 'detail' : 'interaction'; drawFrame();
});
const updateTimer=setInterval(()=>{if(!document.hidden)checkSceneUpdate();},1500);
async function dispose() {
  clearInterval(updateTimer);disposed = true; ++loadToken; renderer.setAnimationLoop(null);
  clearCameraKeys();window.removeEventListener('keydown',cameraKeyDown);window.removeEventListener('keyup',cameraKeyUp);
  window.removeEventListener('blur',clearCameraKeys);window.removeEventListener('focusin',cameraKeyFocus);
  await loadQueue; await exportJob.catch(() => {});
  observer.disconnect();candidates.dispose();if(model)candidates.release(model);annotations.dispose();editor.dispose(); controls.dispose(); document.removeEventListener('visibilitychange', onVisibility);
  disposeModel(scene); scenePass.dispose(); gtao.dispose(); indirect.dispose(); pipeline.dispose();
  for(const filter of [softenedAO,softGI,softGIAO])filter.noiseNode.value.dispose();
  environment.dispose(); draco.dispose(); renderer.dispose(); renderer.domElement.remove();
  for (const element of document.querySelectorAll('button,select')) { element.onclick = null; element.onchange = null; }
}
window.studio = { scene, camera, renderer, pipeline, scenePass, controls, ao, editor, candidates, annotations, loadScene, checkSceneUpdate, setView, setTimeOfDay, get timeOfDay(){return timeOfDay;}, updateCutaway, invalidate, invalidateShadows, exportPNG, dispose,
  selfCheck() {
    if (!model || stats.phase !== 'ready' || stats.backend !== 'webgpu') throw new Error('Scene or actual WebGPU backend is not ready');
    if (!renderer.domElement.width || !renderer.domElement.height || !scene.environment) throw new Error('Missing output or environment');
    return { passed: true, backend: stats.backend, scene: stats.currentScene, triangles: stats.triangles, bounds, cutaway: stats.cutaway };
  }
};
resize();
loadScene(config.scenes[0]);
