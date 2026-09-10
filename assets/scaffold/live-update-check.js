import * as THREE from 'three/webgpu';

// Only run in the disposable live-update fixture described in references/scaffold.md.
// Revision discovery is controlled; modules, GLBs, snapshots, renderer and annotation store are real.
export async function checkLiveUpdates(revisions) {
  const app=window.studio,stats=window.studioStats,checks=[],$=s=>document.querySelector(s);
  if(!document.title.startsWith('在线更新验证')||!app.scene.getObjectByName('other'))throw Error('Use the disposable live-update fixture');
  const assert=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async test=>{const end=performance.now()+15000;while(!test()){if(performance.now()>end)throw Error('Timed out: '+JSON.stringify(stats.liveUpdate));await wait(40);}};
  const fetchBefore=window.fetch,renderBefore=app.pipeline.render,renderer=app.renderer,canvas=renderer.domElement,origin=performance.timeOrigin;
  let advertised=revisions.baseline,comment;
  window.fetch=(url,options)=>String(url)==='/api/scene-update'?Promise.resolve(new Response(JSON.stringify(advertised),{headers:{'Content-Type':'application/json'}})):fetchBefore(url,options);
  const publish=async value=>{advertised=value;await app.checkSceneUpdate({retry:true});};
  const object=name=>app.scene.getObjectByName(name);
  const clickPoint=root=>{
    const rect=canvas.getBoundingClientRect(),point=new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3()).project(app.camera);
    return [(point.x+1)*rect.width/2+rect.left,(1-point.y)*rect.height/2+rect.top];
  };
  try {
    await publish(revisions.baseline);assert(object('wall').material.map?.image?.width===4,'Generated blob texture survives revision URL handling');app.setView('hero');app.editor.setEnabled(true);
    app.editor.select('table');app.editor.setPose({x:-1.2,z:0,angle:30});
    app.editor.select('other');app.editor.setPose({x:1.4,z:0,angle:15});app.editor.select(null);
    await wait(220);await app.annotations.beginAt(...clickPoint(object('other')));
    assert(app.annotations.composing,'Comment opens on the existing furniture');
    const field=$('#annotation-composer textarea');field.value='自动验证：在线更新后仍关联这张边桌';$('#annotation-composer').requestSubmit();
    await until(()=>!app.annotations.composing);await app.annotations.reload();
        comment=app.annotations.list().find(r=>r.text==='自动验证：在线更新后仍关联这张边桌');
    assert(comment?.target.id==='asset:other','Persisted comment identifies the intended object');
    await app.annotations.beginAt(...clickPoint(object('other')));field.value='尚未保存的用户草稿';
    const before=object('other'),frames=stats.renderedFrames;
    advertised=revisions.changed;const job=app.checkSceneUpdate({retry:true});
    await until(()=>stats.liveUpdate?.phase==='waiting');
    assert(object('other')===before&&app.annotations.composing&&field.value==='尚未保存的用户草稿','Prepared revision waits without losing the draft or replacing current objects');
    $('#annotation-composer button[type=button]').click();
    const cameraBefore=app.camera.position.clone(),targetBefore=app.controls.target.clone(),fov=app.camera.fov;
    await job;
    assert(stats.liveUpdate?.phase==='ready'&&stats.liveUpdate.appliedRevision===revisions.changed.revision,'Completed revision is applied without a page reload');
    assert(app.renderer===renderer&&renderer.domElement===canvas&&performance.timeOrigin===origin,'Renderer, canvas and page lifetime are unchanged');
    assert(app.camera.position.distanceTo(cameraBefore)<1e-8&&app.controls.target.distanceTo(targetBefore)<1e-8&&app.camera.fov===fov,'Camera position, target and field of view survive');
    assert(Math.abs(object('table').position.x+.1)<1e-8&&Math.abs(object('other').position.x-1.4)<1e-8,'Authored pose replaces its stale override; unrelated user placement survives');
    assert(object('wall').material.color.getHexString()==='547b9a','Relative JS dependency uses the new revision');
    assert(['attached','moved'].includes(app.annotations.list().find(r=>r.id===comment.id).currentTarget.state),'Existing spatial comment rebinds to the same stable object');
    assert(stats.renderedFrames>frames,'Successful commit renders the new content');
    const good=object('other'),version=stats.sceneVersion;
    for(const key of ['missing','syntax','texture']) {
      await publish(revisions[key]);
      assert(stats.liveUpdate.phase==='error'&&object('other')===good&&stats.sceneVersion===version&&stats.phase==='ready',key+' failure keeps the complete previous scene');
    }
    app.pipeline.render=()=>{app.pipeline.render=renderBefore;throw Error('Injected first-render failure');};
    await publish(revisions.recovery);app.pipeline.render=renderBefore;
    assert(stats.liveUpdate.phase==='error'&&object('other')===good&&Math.abs(good.position.x-1.4)<1e-8,'Compile failure rolls back content and furniture edits');
    assert(['attached','moved'].includes(app.annotations.list().find(r=>r.id===comment.id).currentTarget.state),'Rollback restores comment associations');
    await publish(revisions.recovery);
    assert(stats.liveUpdate.phase==='ready'&&stats.sceneVersion===version+1,'Retry recovers from a failed application');
    // Stop an actual transform gesture from being interrupted at commit.
    const transform=object('Furniture transform handles').controls;
    app.editor.select('other');transform.dragging=true;
    advertised=revisions.changed;const dragJob=app.checkSceneUpdate({retry:true});await until(()=>stats.liveUpdate.phase==='waiting');
    assert(app.editor.state.dragging&&stats.liveUpdate.appliedRevision===revisions.recovery.revision,'Furniture drag defers the commit');
    transform.dragging=false;await dragJob;
    let queued;
    app.pipeline.render=(...args)=>{
      renderBefore.apply(app.pipeline,args);app.pipeline.render=renderBefore;queued=app.loadScene('1');
    };
    await publish(revisions.recovery);await queued;
    const lastModel=performance.getEntriesByType('resource').filter(r=>r.name.endsWith('/models/model-1.glb')).at(-1);
    assert(lastModel?.name.includes(revisions.recovery.revision),'Layout choice queued during commit loads assets from the newly committed revision');
    app.editor.select(null);const png=await app.exportPNG({download:false,width:640});
    assert(png.size>1000&&stats.phase==='ready','Export remains usable after update and rollback');
    await app.annotations.close(comment.id,'自动验证完成：版本替换、空间关联、草稿保护与失败回退均通过');
    return {passed:true,checks,backend:stats.backend,commitMs:stats.commitMs,renderSize:stats.renderSize};
  } finally {
    app.pipeline.render=renderBefore;window.fetch=fetchBefore;
    const transform=object('Furniture transform handles')?.controls;if(transform)transform.dragging=false;
    if(app.annotations.composing)$('#annotation-composer button[type=button]').click();
    app.invalidate();
  }
}
