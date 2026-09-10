// Run in a dedicated visible viewer: await (await import('./performance-check.js')).checkPerformance()
// rAF intervals include browser scheduling. These are not GPU timer measurements.
export async function checkPerformance({ durationMs = 5000, minFps = 40 } = {}) {
  const { controls, camera } = window.studio, stats = window.studioStats;
  if (stats.phase !== 'ready' || document.hidden) throw new Error('Open a loaded, visible viewer first');
  const saved = { position: camera.position.clone(), target: controls.target.clone(), enabled: controls.enabled, damping: controls.enableDamping, autoRotate: controls.autoRotate };
  const version = stats.sceneVersion, rect = document.querySelector('#picture').getBoundingClientRect(), dpr = devicePixelRatio;
  const buttons = [...document.querySelectorAll('button,select')].map(element => [element, element.disabled]);
  const editorBusy=window.studio.editor.state.busy;window.studio.editor.setBusy(true);
  let contaminated = false;
  const onVisibility = () => { contaminated = true; };
  document.addEventListener('visibilitychange', onVisibility);
  const assertStable = () => {
    const now = document.querySelector('#picture').getBoundingClientRect();
    if (contaminated || document.hidden || stats.sceneVersion !== version || stats.phase !== 'ready' || now.width !== rect.width || now.height !== rect.height || dpr !== devicePixelRatio) throw new Error('Discarded: scene, visibility or viewport changed');
  };
  for (const [element] of buttons) element.disabled = true;
  controls.enabled = false; controls.autoRotate = false; controls.enableDamping = false; controls.update();
  const offset = saved.position.clone().sub(saved.target), radius = Math.hypot(offset.x, offset.z), angle = Math.atan2(offset.x, offset.z);
  function pose(time) {
    const a = angle + .2 * Math.sin(time / 1000);
    camera.position.set(saved.target.x + radius * Math.sin(a), saved.position.y, saved.target.z + radius * Math.cos(a));
    controls.update(); window.studio.invalidate();
  }
  async function orbit(duration) {
    const intervals = [], start = performance.now(); let previous = 0;
    await new Promise((resolve, reject) => {
      function frame(time) {
        try {
          assertStable(); pose(time - start);
          if (previous) intervals.push(time - previous); previous = time;
          if (time - start < duration) requestAnimationFrame(frame); else resolve();
        } catch (caught) { reject(caught); }
      }
      requestAnimationFrame(frame);
    });
    return intervals;
  }
  try {
    await orbit(1500); // Warm the actual moving graph, not just a static frame.
    const intervals = await orbit(durationMs);
    if (intervals.length < 2) throw new Error('Insufficient frames');
    const ordered = [...intervals].sort((a,b) => a-b);
    const fps = 1000 * intervals.length / intervals.reduce((a,b) => a+b, 0);
    return { passed: fps >= minFps, minimumFps: minFps, backend: stats.backend, threeRevision: stats.threeRevision, fps: +fps.toFixed(1), medianMs: +ordered[Math.floor(ordered.length*.5)].toFixed(1), p95Ms: +ordered[Math.floor(ordered.length*.95)].toFixed(1), frames: intervals.length, scene: stats.currentScene, cssSize: [rect.width,rect.height], screenDpr: dpr, renderSize: [...stats.renderSize], ao: window.studio.ao.enabled, drawCalls: stats.drawCalls, trianglesPerFrame: stats.renderedTrianglesIncludingPasses, at: new Date().toISOString() };
  } finally {
    camera.position.copy(saved.position); controls.target.copy(saved.target); controls.update();
    controls.enabled = saved.enabled; controls.enableDamping = saved.damping; controls.autoRotate = saved.autoRotate;
    for (const [element, disabled] of buttons) element.disabled = disabled;
    window.studio.editor.setBusy(editorBusy);
    document.removeEventListener('visibilitychange', onVisibility); window.studio.invalidate();
  }
}
export async function checkIdle() {
  const { controls } = window.studio, stats = window.studioStats;
  const saved = { enabled: controls.enabled, damping: controls.enableDamping, autoRotate: controls.autoRotate };
  controls.enabled = false; controls.enableDamping = false; controls.autoRotate = false; controls.update();
  try {
    await new Promise(resolve => setTimeout(resolve, 700));
    const before = stats.renderedFrames, version = stats.sceneVersion;
    await new Promise(resolve => setTimeout(resolve, 600));
    if (document.hidden || stats.sceneVersion !== version) throw new Error('Idle check interrupted');
    return { passed: stats.renderedFrames === before, additionalFrames: stats.renderedFrames-before, renderMode: stats.renderMode, ao: window.studio.ao.enabled, renderSize: [...stats.renderSize] };
  } finally { controls.enabled = saved.enabled; controls.enableDamping = saved.damping; controls.autoRotate = saved.autoRotate; }
}

// DOM keyboard events and the real rAF loop exercise movement and interrupted key releases.
export async function checkCameraKeys() {
  const app=window.studio,{camera,controls,editor}=app,checks=[],measurements=[];
  if(document.hidden||window.studioStats.phase!=='ready')throw Error('Open a loaded, visible viewer first');
  const saved={scene:window.studioStats.currentScene,position:camera.position.clone(),target:controls.target.clone(),fov:camera.fov,
    damping:controls.enableDamping,enabled:controls.enabled,rotate:controls.enableRotate,auto:controls.autoRotate,
    view:document.querySelector('#view').value,editorEnabled:editor.state.enabled,selected:editor.state.selected,focus:document.activeElement};
  const assert=(ok,message)=>{if(!ok)throw Error(message);checks.push(message);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const key=(type,code,target=window,extra={})=>{const event=new KeyboardEvent(type,{code,key:code,bubbles:true,cancelable:true,...extra});target.dispatchEvent(event);return event;};
  const release=()=>{for(const code of ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'])key('keyup',code);};
  const offset=camera.position.clone().sub(controls.target),radius=offset.length();
  function face(x,z,top=false) {
    release();controls.target.copy(saved.target);
    camera.position.copy(saved.target).add(offset.set(top?0:-x*radius*.8,top?radius:radius*.4,top?0:-z*radius*.8));
    if(top)camera.position.z+=.00001;
    controls.update();app.updateCutaway();app.invalidate();
  }
  async function move(codes,target=window,extra={}) {
    const before=camera.position.clone(),aim=controls.target.clone(),start=performance.now();
    for(const code of codes)key('keydown',code,target,extra);
    await wait(260);for(const code of codes)key('keyup',code,target);await wait(40);
    const delta=camera.position.clone().sub(before);
    assert(Math.abs(delta.y)<1e-6 && controls.target.clone().sub(aim).distanceTo(delta)<1e-6,'Camera and orbit target translate together at constant height');
    return {delta,distance:delta.length(),elapsed:performance.now()-start};
  }
  try {
    saved.focus?.blur?.();editor.setEnabled(true);controls.enabled=true;controls.enableDamping=false;controls.autoRotate=false;controls.update();
    let object;app.scene.traverse(o=>{if(!object&&o.userData.editableLabel)object=o;});
    if(object)editor.select(object);
    const furniturePosition=object?.position.clone(),furnitureQuaternion=object?.quaternion.clone();
    for(const [heading,codes,expected] of [
      [[0,-1],['KeyW'],[0,0,-1]],[[0,-1],['ArrowUp'],[0,0,-1]],
      [[0,-1],['KeyS'],[0,0,1]],[[0,-1],['ArrowDown'],[0,0,1]],
      [[1,0],['KeyD'],[0,0,1]],[[1,0],['ArrowRight'],[0,0,1]],
      [[1,0],['KeyA'],[0,0,-1]],[[1,0],['ArrowLeft'],[0,0,-1]],
      [[1,0],['KeyW'],[1,0,0]],
    ]) {
      face(...heading);const result=await move(codes);
      assert(result.distance>.05 && result.delta.clone().normalize().distanceTo(offset.set(...expected))<1e-5,'Camera-relative direction: '+codes.join('+')+' facing '+heading);
      measurements.push({keys:codes,heading,distance:result.distance,elapsed:result.elapsed});
    }
    face(0,-1);const straight=await move(['KeyW']);face(0,-1);const diagonal=await move(['KeyW','KeyD']);
    face(0,-1);const aliases=await move(['KeyW','ArrowUp']);
    assert(diagonal.distance/straight.distance>.8 && diagonal.distance/straight.distance<1.2 && aliases.distance/straight.distance>.8 && aliases.distance/straight.distance<1.2,'Diagonal and alias keys keep the same movement speed');
    face(0,-1,true);const top=await move(['KeyW']);assert(top.distance>.05 && top.delta.z<0 && Math.abs(top.delta.x)<1e-6,'Straight-down plan view has a stable horizontal heading');
    const tapStart=camera.position.clone();key('keydown','KeyW');await wait(2);key('keyup','KeyW');assert(camera.position.distanceTo(tapStart)>0,'A short tap is integrated before key release');
    const stopped=camera.position.clone();await wait(140);assert(camera.position.distanceTo(stopped)<1e-6,'Releasing keys stops translation');
    const field=document.createElement('input');document.body.append(field);
    try{field.focus();const result=await move(['ArrowUp'],field);assert(result.distance<1e-6,'Typing in an input does not move the camera');}finally{field.remove();}
    const shortcut=await move(['KeyW'],window,{ctrlKey:true});assert(shortcut.distance<1e-6,'Browser modifier shortcuts do not move the camera');
    key('keydown','KeyW');window.dispatchEvent(new Event('blur'));const blurred=camera.position.clone();key('keydown','KeyW',window,{repeat:true});await wait(120);release();
    assert(camera.position.distanceTo(blurred)<1e-6,'Blur cancels held keys and ignores resumed OS repeats');
    key('keydown','KeyW');controls.enabled=false;await wait(60);controls.enabled=true;const resumed=camera.position.clone();await wait(120);release();
    assert(camera.position.distanceTo(resumed)<1e-6,'Pausing camera controls clears held movement');
    key('keydown','KeyW');const exporting=camera.position.clone();await app.exportPNG({download:false,width:320});await wait(120);release();
    assert(camera.position.distanceTo(exporting)<1e-6,'Export cancels held movement and does not restart it');
    if(object)assert(object.position.distanceTo(furniturePosition)<1e-6 && object.quaternion.angleTo(furnitureQuaternion)<1e-6,'Keys move the camera while leaving selected furniture unchanged');
    const other=[...document.querySelectorAll('[data-layout]')].find(b=>b.dataset.layout!==saved.scene)?.dataset.layout;
    if(other){key('keydown','KeyW');await app.loadScene(other);const loaded=camera.position.clone();await wait(120);release();assert(camera.position.distanceTo(loaded)<1e-6,'Scene switching cancels held movement');}
    return {passed:true,checks,measurements,backend:window.studioStats.backend};
  } finally {
    release();if(window.studioStats.currentScene!==saved.scene)await app.loadScene(saved.scene);
    app.setView(saved.view);camera.position.copy(saved.position);controls.target.copy(saved.target);camera.fov=saved.fov;
    controls.enableDamping=false;controls.autoRotate=false;controls.update();controls.enableDamping=saved.damping;controls.enabled=saved.enabled;controls.autoRotate=saved.auto;controls.enableRotate=saved.rotate;
    camera.updateProjectionMatrix();app.updateCutaway();editor.select(saved.selected);editor.setEnabled(saved.editorEnabled);saved.focus?.focus?.();app.invalidate();
  }
}
