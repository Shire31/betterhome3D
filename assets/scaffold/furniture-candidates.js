import * as THREE from 'three/webgpu';

// One slot keeps its transform and identity. Its parked alternatives belong to the
// same scene content, so the existing scene disposal releases every GPU resource.
export function createFurnitureCandidates({host,load,disposeModel,commit,invalidate}) {
  const rail=document.createElement('aside');rail.id='furniture-candidates';rail.hidden=true;rail.setAttribute('aria-label','家具候选');host.append(rail);
  const list=document.createElement('div');list.className='candidate-list';list.setAttribute('role','group');list.setAttribute('aria-label','替换款式');
  const message=document.createElement('p');message.className='candidate-message';message.setAttribute('role','status');rail.append(list,message);
  const models=new WeakMap(),choices=new Map();
  let current=null,selected=null,request=0,dead=false;
  const key=state=>JSON.stringify([state.sceneId,state.root.name]);
  function render() {
    const state=selected;rail.hidden=!state;host.classList.toggle('has-candidates',!!state);
    if(!state){list.replaceChildren();return;}
    if(list.dataset.slot!==key(state)) {
      list.dataset.slot=key(state);list.replaceChildren();
      for(const option of state.options.values()) {
        const button=document.createElement('button');button.type='button';button.dataset.candidate=option.id;button.title=option.label;
        button.setAttribute('aria-label','换成 '+option.label);
        const image=document.createElement('img');image.src=state.resolveURL(option.thumbnail);image.alt=option.label;image.draggable=false;
        const label=document.createElement('span');label.textContent=option.label;button.append(image,label);
        button.onclick=()=>choose(option.id).catch(()=>{});list.append(button);
      }
    }
    for(const button of list.children) {
      const entry=state.entries.get(button.dataset.candidate);
      button.setAttribute('aria-pressed',String(state.active===button.dataset.candidate));
      button.dataset.loading=String(!!entry?.pending);button.disabled=state.busy;
    }
    message.textContent=state.error||(state.busy?'正在替换…':'');
  }
  async function ready(state,id) {
    let entry=state.entries.get(id);if(entry?.group)return entry;if(entry?.pending)return entry.pending;
    const option=state.options.get(id);if(!option)throw Error('此家具没有这个候选');
    entry={};state.entries.set(id,entry);
    entry.pending=(async()=>{
      let group;
      try {
        group=await load(option,state.revision);
        if(dead||state.retired){disposeModel(group);throw Error('场景已切换');}
        // A candidate GLB is a complete visual unit; the stable slot owns annotations/editing.
        group.traverse(o=>{delete o.userData.annotation;delete o.userData.editableLabel;});
        state.storage.add(group);entry.group=group;return entry;
      } catch(error){state.entries.delete(id);throw error;}
      finally {delete entry.pending;if(selected===state)render();}
    })();
    render();return entry.pending;
  }
  function install(state,id) {
    const old=state.active,previous=state.entries.get(old),next=state.entries.get(id);
    if(!next?.group)throw Error('候选尚未准备完成');
    state.storage.add(previous.group);state.root.add(next.group);state.active=id;
    const option=state.options.get(id);
    state.root.userData.annotation={...state.annotation,label:option.label,source:option.url};
    state.root.userData.candidateLabel=option.label;state.root.updateMatrixWorld(true);
    return ()=>install(state,old);
  }
  async function choose(id) {
    const state=selected,token=++request;if(!state)throw Error('请先选择家具');
    if(!state.options.has(id))throw Error('此家具没有这个候选');
    if(id===state.active)return;
    state.busy=true;state.pendingChoice=token;state.error='';render();
    try {
      await ready(state,id);
      if(token!==request||state!==selected)return;
      await commit(()=>{
        if(token!==request||state!==selected||current?.slots.get(state.root.name)!==state)throw Error('选择已变化');
        return install(state,id);
      });
      choices.set(key(state),id);invalidate();
    } catch(error){if(token===request){state.error=error.message;throw error;}}
    finally {if(state.pendingChoice===token)state.busy=false;render();}
  }
  function trim() {
    for(const state of current?.slots.values()||[])if(state!==selected) {
      for(const [id,entry] of state.entries)if(id!=='default'&&id!==state.active&&entry.group){entry.group.removeFromParent();disposeModel(entry.group);state.entries.delete(id);}
    }
  }
  function select(root) {
    const next=current?.slots.get(root?.name)||null;
    if(next===selected)return;
    ++request;selected=next;list.dataset.slot='';trim();render();
    if(next)(async()=>{
      // Preload only this furniture's alternatives, sequentially; no extra WebGPU canvas.
      for(const id of next.options.keys()) {
        if(selected!==next||dead)break;
        try{await ready(next,id);}catch{/* Clicking a failed candidate retries and reports the error. */}
        if(selected!==next)trim();
      }
    })();
  }
  return {
    select,choose,
    async prepare(model,definition,revision,resolveURL) {
      const storage=new THREE.Group();storage.name='Parked furniture candidates';storage.visible=false;storage.userData.candidateStorage=true;model.add(storage);
      const slots=new Map();models.set(model,{slots});
      for(const asset of definition.assets||[]) {
        if(!asset.candidates?.length)continue;
        const root=model.getObjectByName(asset.name);
        if(!root||root.parent!==model)throw Error('家具候选需要独立、唯一的 name：'+asset.name);
        const initial={id:'default',url:asset.url,label:asset.candidateLabel||asset.editable||asset.name,thumbnail:asset.thumbnail};
        const options=new Map();
        for(const option of [initial,...asset.candidates]) {
          if(!option.id||options.has(option.id)||!option.url||!option.label||!option.thumbnail)throw Error('候选需要唯一 id、label、url 和 thumbnail：'+asset.name);
          options.set(option.id,option);
        }
        const body=new THREE.Group();body.name=asset.name+' · default candidate';body.scale.copy(root.scale);root.scale.setScalar(1);
        for(const child of [...root.children])body.add(child);root.add(body);root.userData.hasCandidates=true;
        const state={root,sceneId:definition.id,storage,options,entries:new Map([['default',{group:body}]]),active:'default',annotation:{...root.userData.annotation},label:root.userData.editableLabel||root.userData.annotation.label,resolveURL,revision};
        slots.set(root.name,state);
        const saved=choices.get(key(state));if(saved&&saved!=='default'&&options.has(saved)){await ready(state,saved);install(state,saved);}
      }
    },
    bind(model){++request;current=models.get(model)||{slots:new Map()};selected=null;list.dataset.slot='';render();},
    release(model){const state=models.get(model);if(state){for(const slot of state.slots.values())slot.retired=true;models.delete(model);}},
    refresh(){render();},
    get session(){return [...choices];},
    restoreSession(value){choices.clear();for(const [slot,id] of value)choices.set(slot,id);},
    get state(){return {selected:selected?.root.name??null,active:selected?.active??null,busy:!!selected?.busy,error:selected?.error||'',options:selected?[...selected.options.values()].map(o=>({id:o.id,label:o.label,ready:!!selected.entries.get(o.id)?.group})):[]};},
    dispose(){dead=true;++request;rail.remove();host.classList.remove('has-candidates');}
  };
}
