import * as THREE from 'three/webgpu';
import { pickSurface } from './furniture-editor.js';

// This owner keeps spatial anchors, GPU markers, snapshots and the durable comment API together.
export function createAnnotations({scene,camera,canvas,controls,editor,config,invalidate,exportPNG,loadScene,setView,isBusy}) {
  const host=canvas.parentElement, $=selector=>document.querySelector(selector);
  const node=(tag,text='',className='')=>{const element=document.createElement(tag);element.textContent=text;element.className=className;return element;};
  const toggle=node('button','评论 · 0');toggle.id='annotations-toggle';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls','annotation-panel');$('header .tools').append(toggle);
  const markers=new THREE.Group();markers.name='Annotation markers';markers.userData.editorOverlay=true;scene.add(markers);
  const sphere=new THREE.SphereGeometry(1,12,8),blue=new THREE.MeshBasicMaterial({color:'#1476ed',toneMapped:false});
  const white=new THREE.MeshBasicMaterial({color:'white',side:THREE.BackSide,toneMapped:false});
  const markerRay=new THREE.Raycaster(),markerPointer=new THREE.Vector2();let exporting=false;

  const draftDot=node('span','','annotation-pin');draftDot.id='annotation-draft-dot';draftDot.hidden=true;host.append(draftDot);
  const panel=node('aside');panel.id='annotation-panel';panel.hidden=true;panel.setAttribute('aria-label','空间批注');host.append(panel);
  const iconButton=(label,path)=>{
    const button=node('button','','icon-button');button.type='button';button.setAttribute('aria-label',label);button.title=label;
    button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;return button;
  };
  const head=node('div','','annotation-head'),title=node('h2','评论'),hide=iconButton('收起评论列表','M6 6l12 12M18 6L6 18');head.append(title,hide);panel.append(head);
  panel.append(node('p','双击表面添加评论，点击圆球查看。','annotation-hint'));
  const filterLabel=node('label'),filter=node('input');filter.type='checkbox';filterLabel.append(filter,document.createTextNode(' 查看已关闭'));panel.append(filterLabel);
  const message=node('p','','annotation-error');message.setAttribute('role','status');panel.append(message);
  const cards=node('div');panel.append(cards);
  const form=node('form');form.id='annotation-composer';form.hidden=true;form.setAttribute('aria-label','添加空间评论');host.append(form);
  const subject=node('span','','sr-only');subject.id='annotation-subject';form.setAttribute('aria-describedby',subject.id);
  const input=node('textarea');input.rows=1;input.placeholder='Add a comment…';input.setAttribute('aria-label','评论内容');input.maxLength=4000;input.required=true;
  const formError=node('p','','annotation-error');formError.setAttribute('role','status');
  const save=iconButton('保存评论','M12 19V5m-6 6 6-6 6 6');save.type='submit';save.classList.add('primary');
  const cancel=iconButton('取消评论','M6 6l12 12M18 6L6 18'),composerRow=node('div','','composer-row');composerRow.append(cancel,input,save);form.append(subject,composerRow,formError);
  let records=[],roots=new Map(),pinNodes=new Map(),currentId='',currentLabel='',draft=null,dead=false,dirty=true,lastMatrix='',refreshing=null;
  const popupResize=new ResizeObserver(()=>{dirty=true;invalidate();});popupResize.observe(form);
  const hashes=new WeakMap();
  const visible=object=>{for(let p=object;p;p=p.parent)if(!p.visible)return false;return true;};
  const round=value=>Math.round(value*1e6)/1e6;
  const sha=async buffer=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');
  function bufferHash(buffer){if(!hashes.has(buffer))hashes.set(buffer,sha(buffer));return hashes.get(buffer);}
  async function signature(root) {
    const inverse=root.matrixWorld.clone().invert(),parts=[];
    root.traverse(object=>{
      if(!object.isMesh)return;
      const geometry=object.geometry,position=geometry.attributes.position;
      const array=position?.isInterleavedBufferAttribute?position.data.array:position?.array;
      parts.push(Promise.all([array?bufferHash(array.buffer):'',geometry.index?bufferHash(geometry.index.array.buffer):'']).then(buffers=>({
        name:object.name,buffers,vertices:position?.count,transform:new THREE.Matrix4().multiplyMatrices(inverse,object.matrixWorld).elements.map(round),
        materials:[object.material].flat().map(m=>({name:m.name,color:m.color?.getHex(),roughness:m.roughness,metalness:m.metalness}))
      })));
    });
    return sha(new TextEncoder().encode(JSON.stringify({source:root.userData.annotation.source,parts:await Promise.all(parts)})));
  }
  async function request(path='',options={}) {
    const response=await fetch('/api/annotations'+path,{cache:'no-store',...options,headers:{'Content-Type':'application/json',...options.headers}});
    let result;try{result=await response.json();}catch{throw Error('批注服务不可用，请使用项目的 npm start 启动。');}
    if(!response.ok)throw Error(result.error||'批注保存失败');return result;
  }
  function state(record) {
    if(record.sceneId!==currentId)return {kind:'other',label:'另一方案'};
    const entry=roots.get(record.target.id);
    if(!entry)return {kind:'missing',label:'原对象缺失，保留原截图'};
    if(entry.signature!==record.target.signature)return {kind:'changed',label:'对象内容已变化，需核对原截图'};
    const point=entry.object.localToWorld(new THREE.Vector3().fromArray(record.target.localPoint));
    const moved=entry.object.matrixWorld.elements.some((v,i)=>Math.abs(v-record.target.worldMatrix[i])>1e-5);
    return {kind:moved?'moved':'attached',label:moved?'对象已移动，标记随物体更新':'空间关联正常',object:entry.object,point};
  }
  function present(open) {panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));if(open)reload().catch(error=>message.textContent=error.message);}
  function recordCard(record) {
    const card=node('article','','annotation-card');card.dataset.commentId=record.id;
    const heading=node('div','','annotation-head');heading.append(node('strong',`#${record.number} · ${record.target.label}`));
    card.append(heading,node('p',record.text,'annotation-text'));
    const health=node('p',state(record).label,'annotation-hint');health.dataset.health=record.id;health.hidden=state(record).kind==='attached';card.append(health);
    card.append(node('p',record.sceneLabel,'annotation-hint'));
    const error=node('p','','annotation-error');error.setAttribute('role','status');
    const actions=node('div','','annotation-actions');
    const locate=node('button','查看');locate.onclick=async()=>{try{await goTo(record.id);showRecord(record.id);}catch(e){error.textContent=e.message;}};actions.append(locate);
    const change=node('button',record.status==='open'?'关闭评论':'重新打开');
    change.onclick=()=>{
      if(record.status==='closed'){change.disabled=true;reopen(record.id,'用户重新打开','user').catch(e=>{error.textContent=e.message;change.disabled=false;});return;}
      if(card.querySelector('textarea'))return;
      const reason=node('textarea');reason.placeholder='填写处理说明';reason.setAttribute('aria-label','关闭原因');reason.maxLength=4000;
      const confirm=node('button','确认关闭','primary');confirm.onclick=async()=>{if(!reason.value.trim()){reason.focus();return;}confirm.disabled=true;try{await close(record.id,reason.value,'user');}catch(e){error.textContent=e.message;confirm.disabled=false;}};
      card.append(reason,confirm);reason.focus();
    };
    const details=node('details'),summary=node('summary','原始视角与处理记录');details.append(summary);
    const snapshot=node('img');snapshot.src=record.snapshot;snapshot.loading='lazy';snapshot.alt=`批注 #${record.number} 的原始视角和蓝色落点`;details.append(snapshot);
    for(const event of record.history)if(event.action==='edit')details.append(node('p',`${event.actor==='assistant'?'助手':'你'} · 编辑：${event.previousText} → ${event.text}`,'annotation-hint'));else if(event.note)details.append(node('p',`${event.actor==='assistant'?'助手':'你'} · ${event.status==='closed'?'关闭':'重新打开'}：${event.note}`,'annotation-hint'));
    actions.append(change);card.append(actions,details,error);return card;
  }
  function render() {
    toggle.textContent='评论 · '+records.filter(r=>r.status==='open').length;
    cards.replaceChildren();markers.clear();pinNodes.clear();
    const items=records.filter(r=>filter.checked?r.status==='closed':r.status==='open');
    if(!items.length)cards.append(node('p',filter.checked?'暂无已关闭批注。':'暂无待处理批注。','annotation-hint'));
    for(const record of items)cards.append(recordCard(record));
    for(const record of records.filter(r=>r.status==='open'&&r.sceneId===currentId)) {
      const pin=new THREE.Mesh(sphere,blue),rim=new THREE.Mesh(sphere,white);rim.scale.setScalar(1.16);pin.add(rim);
      pin.name='Annotation #'+record.number;pin.userData.commentId=record.id;pin.visible=false;
      markers.add(pin);pinNodes.set(record.id,pin);
    }
    dirty=true;invalidate();
  }
  async function reload() {
    if(dead)return;
    if(refreshing)return refreshing;
    refreshing=(async()=>{try{const data=await request();if(dead)return;records=data.comments;message.textContent='';render();return list();}catch(error){message.textContent=error.message;throw error;}finally{refreshing=null;}})();
    return refreshing;
  }
  function list({status='open'}={}) {return records.filter(r=>status==='all'||r.status===status).map(record=>({...structuredClone(record),currentTarget:{state:state(record).kind,label:state(record).label}}));}
  async function changeStatus(id,status,note,actor) {
    const data=await request();const record=data.comments.find(r=>r.id===id);if(!record)throw Error('批注不存在');
    const saved=await request('/'+id,{method:'PATCH',body:JSON.stringify({status,note,actor,expectedUpdatedAt:record.updatedAt})});
    records=data.comments.map(r=>r.id===id?saved:r);render();return structuredClone(saved);
  }
  const close=(id,note,actor='assistant')=>changeStatus(id,'closed',note,actor);
  const reopen=(id,note='',actor='assistant')=>changeStatus(id,'open',note,actor);
  function worldPosition(record) {const resolved=state(record);return resolved.point||new THREE.Vector3().fromArray(record.target.worldPoint);}
  async function goTo(id) {
    if(draft)throw Error('请先保存或取消正在编写的评论');
    const record=records.find(r=>r.id===id);if(!record)throw Error('批注不存在');
    if(record.sceneId!==currentId){await loadScene(record.sceneId);if(record.sceneId!==currentId)throw Error('无法加载原方案');}
    setView('orbit');
    const offset=worldPosition(record).sub(new THREE.Vector3().fromArray(record.target.worldPoint));
    camera.position.fromArray(record.camera.position).add(offset);controls.target.fromArray(record.camera.target).add(offset);camera.fov=record.camera.fov;
    const damping=controls.enableDamping;controls.enableDamping=false;controls.update();controls.enableDamping=damping;camera.updateProjectionMatrix();
    const cutaway=$('#cutaway');if((cutaway.getAttribute('aria-pressed')==='true')!==record.camera.cutaway)cutaway.click();
    dirty=true;invalidate();return state(record).label;
  }
  function project(point) {
    const p=point.clone().project(camera),rect=canvas.getBoundingClientRect();
    return {x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2,inside:p.z>=-1&&p.z<=1&&Math.abs(p.x)<=1&&Math.abs(p.y)<=1,rect};
  }
  // Only the open card is projected; GPU spheres remain in the scene render. No position transition or separate timer.
  function place(element,point) {
    const p=project(point);element.hidden=!p.inside||exporting||(!draft&&isBusy());if(element.hidden)return;
    const width=element.offsetWidth,height=element.offsetHeight,margin=10,gap=24;
    const x=p.x+gap+width<=host.clientWidth-margin?p.x+gap:p.x-gap-width;
    element.style.transform=`translate3d(${Math.max(margin,Math.min(x,host.clientWidth-width-margin))}px,${Math.max(margin,Math.min(p.y-24,host.clientHeight-height-margin))}px,0)`;
  }
  function updateComposer() {
    if(!draft)return;
    if(!draft.editing){place(form,new THREE.Vector3().fromArray(draft.record.target.worldPoint));return;}
    const resolved=state(draft.record);
    if(!resolved.point||!visible(resolved.object)){form.hidden=true;return;}
    place(form,pinNodes.get(draft.record.id)?.position||resolved.point);
  }
  function update() {
    if(dead)return;
    markers.visible=(!draft||draft.editing)&&!exporting&&!isBusy();
    if(!markers.visible||!pinNodes.size){updateComposer();return;}
    const key=camera.matrixWorld.elements.join(',')+camera.projectionMatrix.elements.join(',')+canvas.clientHeight+','+canvas.clientWidth;
    if(!dirty&&key===lastMatrix)return;lastMatrix=key;dirty=false;
    for(const [id,pin] of pinNodes) {
      const record=records.find(r=>r.id===id),resolved=state(record);pin.visible=false;
      for(const health of host.querySelectorAll(`[data-health="${id}"]`)){if(health.textContent!==resolved.label)health.textContent=resolved.label;const hidden=resolved.kind==='attached';if(health.hidden!==hidden)health.hidden=hidden;}
      if(!resolved.point||!visible(resolved.object))continue;
      const depth=-resolved.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
      if(depth<=camera.near)continue;
      // Constant apparent size, ordinary depth testing: position and occlusion render in the same GPU frame as the furniture.
      const radius=12*2*depth*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))/Math.max(canvas.clientHeight,1);
      const normal=new THREE.Vector3().fromArray(record.target.localNormal).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(resolved.object.matrixWorld));
      pin.position.copy(resolved.point).addScaledVector(normal,radius*1.2);pin.scale.setScalar(radius);pin.visible=true;
      pin.userData.surfacePoint=resolved.point.toArray();
    }
    markers.updateMatrixWorld(true);
    updateComposer();
  }
  function pickMarker(event) {
    if(draft||exporting||isBusy()||!markers.visible)return null;
    const rect=canvas.getBoundingClientRect();markerPointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    markerRay.setFromCamera(markerPointer,camera);
    const hit=markerRay.intersectObjects([...pinNodes.values()].filter(pin=>pin.visible),false)[0];if(!hit)return null;
    const surface=pickSurface(scene,camera,canvas,event);
    return surface&&surface.distance+.005<hit.distance?null:hit.object.userData.commentId;
  }
  function showRecord(id) {
    if(draft||isBusy()||editor.state.busy)return;
    const record=records.find(r=>r.id===id);if(!record)return;
    if(!state(record).point){present(true);cards.querySelector(`[data-comment-id="${id}"]`)?.scrollIntoView({block:'nearest'});return;}
    openComposer(structuredClone(record),true);
  }
  function openComposer(record,editing=false) {
    const buttons=[...document.querySelectorAll('header button,header select')].map(element=>[element,element.disabled]);
    draft={record,editing,buttons,controls:controls.enabled,editorBusy:editor.state.busy};
    for(const [element] of buttons)element.disabled=true;
    controls.enabled=false;editor.setBusy(true);markers.visible=editing;present(false);host.classList.add('annotation-composing');
    subject.textContent=currentLabel+' · '+record.target.label;form.setAttribute('aria-label',editing?'编辑空间评论':'添加空间评论');
    input.value=editing?record.text:'';input.disabled=false;formError.textContent='';save.disabled=false;cancel.disabled=false;form.hidden=false;
    resizeInput();dirty=true;updateComposer();input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);invalidate();
  }
  function finishDraft() {
    if(!draft)return;const old=draft;draft=null;form.hidden=true;markers.visible=true;draftDot.hidden=true;host.classList.remove('annotation-composing');
    for(const [element,disabled] of old.buttons)element.disabled=disabled;
    controls.enabled=old.controls;editor.setBusy(old.editorBusy);canvas.focus({preventScroll:true});dirty=true;invalidate();
  }
  async function beginAt(clientX,clientY) {
    if(dead||draft||isBusy()||editor.state.busy)return false;
    const hit=pickSurface(scene,camera,canvas,{clientX,clientY});if(!hit)return false;
    let owner=hit.object;while(owner&&!owner.userData.annotation)owner=owner.parent;
    if(!owner||!roots.has(owner.userData.annotation.id)){present(true);message.textContent='该表面缺少唯一的批注标识，请先给场景对象命名。';return false;}
    const entry=roots.get(owner.userData.annotation.id),worldNormal=hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
    const localNormal=worldNormal.applyMatrix3(new THREE.Matrix3().setFromMatrix4(owner.matrixWorld).transpose()).normalize();
    const record={id:crypto.randomUUID(),sceneId:currentId,sceneLabel:currentLabel,target:{id:owner.userData.annotation.id,label:owner.userData.annotation.label,
      source:owner.userData.annotation.source,sourceBase:location.pathname,sceneConfig:new URL('./scene.js',location.href).pathname,signature:entry.signature,localPoint:owner.worldToLocal(hit.point.clone()).toArray(),localNormal:localNormal.toArray(),
      worldPoint:hit.point.toArray(),worldMatrix:owner.matrixWorld.toArray(),hitPath:[]},
      camera:{position:camera.position.toArray(),target:controls.target.toArray(),fov:camera.fov,aspect:camera.aspect,cutaway:$('#cutaway').getAttribute('aria-pressed')==='true'}};
    for(let part=hit.object;part&&part!==owner;part=part.parent)record.target.hitPath.unshift(part.name||`child-${part.parent.children.indexOf(part)}`);
    openComposer(record);const ownDraft=draft,buttons=draft.buttons,p=project(hit.point);
    formError.textContent='正在保存现场视角…';save.disabled=true;cancel.disabled=true;
    draftDot.style.left=p.x+'px';draftDot.style.top=p.y+'px';draftDot.hidden=false;
    try {
      const blob=await exportPNG({download:false,width:960});const bitmap=await createImageBitmap(blob);
      const image=document.createElement('canvas');image.width=bitmap.width;image.height=bitmap.height;const context=image.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
      const x=p.x/p.rect.width*image.width,y=p.y/p.rect.height*image.height;context.beginPath();context.arc(x,y,9,0,Math.PI*2);context.fillStyle='#1476ed';context.fill();context.lineWidth=3;context.strokeStyle='white';context.stroke();
      record.snapshotDataUrl=image.toDataURL('image/jpeg',.86);
      if(draft===ownDraft){formError.textContent='';save.disabled=false;for(const [element] of buttons)element.disabled=true;}
    } catch(error){if(draft===ownDraft)formError.textContent='截图失败，未创建评论：'+error.message;}
    finally{cancel.disabled=false;}
    return true;
  }
  async function submit(event) {
    event.preventDefault();if(!draft||save.disabled||!input.value.trim())return;
    const {record,editing}=draft,text=input.value.trim();save.disabled=true;cancel.disabled=true;input.disabled=true;
    const body=editing?{text,actor:'user',expectedUpdatedAt:record.updatedAt}:{...record,text};
    try {const saved=await request(editing?'/'+record.id:'',{method:editing?'PATCH':'POST',body:JSON.stringify(body)});records=editing?records.map(r=>r.id===saved.id?saved:r):records.filter(r=>r.id!==saved.id).concat(saved);finishDraft();render();}
    catch(error){formError.textContent='未确认保存：'+error.message+'。可重试，不会重复创建。';save.disabled=false;}
    finally{cancel.disabled=false;input.disabled=false;}
  }
  let start=null,dragged=false,pressedPin=null;
  const pointerDown=e=>{
    if(e.target!==canvas)return;start=[e.clientX,e.clientY];pressedPin=e.button===0?pickMarker(e):null;
    if(pressedPin){e.preventDefault();e.stopImmediatePropagation();}
  };
  const pointerUp=e=>{
    if(e.target!==canvas)return;dragged=!!start&&Math.hypot(e.clientX-start[0],e.clientY-start[1])>5;start=null;
    if(pressedPin){e.preventDefault();e.stopImmediatePropagation();if(!dragged)showRecord(pressedPin);pressedPin=null;}
  };
  const doubleClick=e=>{if(e.button===0&&!dragged){e.preventDefault();const id=pickMarker(e);if(id)showRecord(id);else beginAt(e.clientX,e.clientY).catch(error=>message.textContent=error.message);}};
  const escape=e=>{if(e.key!=='Escape')return;if(draft){e.stopPropagation();if(!cancel.disabled)finishDraft();}else if(!panel.hidden){e.stopPropagation();present(false);canvas.focus({preventScroll:true});}};
  const outside=e=>{if(panel.contains(e.target)||form.contains(e.target)||toggle.contains(e.target))return;present(false);};
  const focus=()=>{if(!dead&&!draft)reload().catch(()=>{});};
  function resizeInput(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,120)+'px';}
  input.oninput=resizeInput;
  form.addEventListener('submit',submit);cancel.onclick=finishDraft;canvas.tabIndex=0;canvas.setAttribute('aria-label','三维场景，双击表面添加评论');
  toggle.onclick=()=>present(panel.hidden);hide.onclick=()=>present(false);filter.onchange=render;
  host.addEventListener('pointerdown',pointerDown,true);host.addEventListener('pointerup',pointerUp,true);canvas.addEventListener('dblclick',doubleClick);window.addEventListener('focus',focus);
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
  reload().catch(()=>{});
  return {list,reload,close,reopen,goTo,beginAt,update,setExporting(value){exporting=value;markers.visible=!value&&(!draft||draft.editing);if(value){form.hidden=true;draftDot.hidden=true;}else if(draft&&!draft.editing){draftDot.hidden=false;}dirty=true;},markDirty(){dirty=true;},get composing(){return !!draft;},
    async bind(definition) {
      finishDraft();currentId=definition.id;currentLabel=definition.label||definition.id;roots=new Map();scene.updateMatrixWorld(true);
      const candidates=[],ids=new Set(),duplicates=new Set();scene.traverse(object=>{for(let p=object;p;p=p.parent)if(p.userData.candidateStorage)return;const tag=object.userData.annotation;if(tag){if(ids.has(tag.id))duplicates.add(tag.id);ids.add(tag.id);candidates.push(object);}});
      await Promise.all(candidates.filter(o=>!duplicates.has(o.userData.annotation.id)).map(async object=>{roots.set(object.userData.annotation.id,{object,signature:await signature(object)});}));
      render();if(duplicates.size)message.textContent='重复的批注标识不可绑定：'+[...duplicates].join(', ');
    },
    dispose(){dead=true;finishDraft();popupResize.disconnect();document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);host.removeEventListener('pointerdown',pointerDown,true);host.removeEventListener('pointerup',pointerUp,true);canvas.removeEventListener('dblclick',doubleClick);window.removeEventListener('focus',focus);toggle.remove();markers.removeFromParent();sphere.dispose();blue.dispose();white.dispose();draftDot.remove();panel.remove();form.remove();}
  };
}
