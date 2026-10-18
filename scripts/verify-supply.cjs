// Run the real allocation, dispatch and receipt functions with rendering disabled.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const inline=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m=>!m[1].includes('src='));
const logistics=fs.readFileSync(path.join(root,'assets/logistics-stage.js'),'utf8');
for(const script of inline)new vm.Script(script[2]);
new vm.Script(logistics);
const run=(context,code)=>vm.runInContext(code,context);

async function setup({people=96,speed=2,configure=''}={}){
 const context=vm.createContext({console,performance,AbortController,
  setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},requestAnimationFrame:()=>0,cancelAnimationFrame(){},
  fetch:async()=>{throw Error('Audit uses the bundled road cache');},
  window:{addEventListener(){}},document:{addEventListener(){},querySelectorAll:()=>[],getElementById:()=>null}
 });
 run(context,inline[0][2]);run(context,logistics);
 await run(context,`(async()=>{
   VIEW.draw=()=>{};drawLogisticsCalculation=()=>{};drawLogisticsPanels=()=>{};applyNodeStates=()=>{};
  drawCtl=()=>{};drawFloat=()=>{};drawKpis=()=>{};updateClock=()=>{};enterStep=i=>{S.step=i;};
  INCIDENT.villageReport.shelteredPeople=${people};S.cfg.speed=${speed};${configure}
  S.incident.result=incidentResult();S.logistics=logisticsState();S.started=true;S.step=3;S.muted=true;
  prepareSupplyNeeds();allocateSupply();await planInitialRoutes();planDeliveryRoutes();await S.logistics.roadRoutesPending;buildCooperativeTasks();
  S.step=7;S.sim=8;
 })()`);
 assert.equal(run(context,'logisticsQuantityCheck().ok'),true,'Initial plan must conserve quantities by material and source');
 return context;
}

function finish(context){
 let ticks=0;
 while(run(context,'S.step<9')&&ticks++<10000){
  run(context,'transportTick()');
  assert.equal(run(context,"S.tasks.some(t=>t.mode==='team')"),false,'Personnel delivery tasks must not be created');
  const check=run(context,'logisticsQuantityCheck()');
  assert.equal(check.ok,true,check.errors.join('; '));
  if(run(context,"S.tasks.every(t=>t.status==='done')"))break;
 }
 assert.ok(ticks<10000,'Transport must finish without a dependency deadlock');
 return ticks;
}

function report(context){
 return JSON.parse(run(context,`JSON.stringify({
  people:S.logistics.peopleCount,needs:S.logistics.needs,allocations:S.logistics.allocations,
  warehouses:matchedWarehouseIds().map(id=>({id,name:ALL[id].name,initial:LOGISTICS_CFG.inventory[id],remaining:S.logistics.onHandStock[id]})),
  tasks:S.tasks.map(t=>({id:t.id,mode:t.mode,preposition:!!t.preposition,returning:!!t.returning,finalDelivery:!!t.finalDelivery,depot:t.depot,target:t.target,
   weight:t.weight,capacity:t.capacity,manifest:t.manifest,status:t.status,confirmed:!!t.confirmed})),
  check:S.logistics.quantityCheck,logs:S.logs.map(l=>l.txt)
 })`));
}

(async()=>{
 let defaultReport;
 const expected={water:576,food:288,hygiene:20,blanket:96,medical:2,light:4};
 for(const speed of [1,2,4]){
  const context=await setup({speed});
 assert.equal(run(context,'S.incident.result.shelteredPeople'),96,'The opening report must use the village-reported, already-sheltered population');
 assert.equal(run(context,"S.logistics.needs.some(m=>m.mat==='boat')"),false,'Rescue boats must be excluded from the dispatch list');
 const villageList=run(context,'logisticsConfirmationMarkup(1,S.logistics)');
 assert.match(villageList,/村委会上报/);assert.doesNotMatch(villageList,/AI|救生艇/);
 const routePlan=run(context,'logisticsConfirmationMarkup(5,S.logistics)');
 for(const detail of ['顺丰速运绵阳','中国邮政EMS','川B12V31','川B34121','FlyCart 200','SC_MY_QS_A003_01','SC_MY_QS_A003_02','SC_MY_QS_A003_03','协同原因','山体滑坡'])assert.ok(routePlan.includes(detail),'Route confirmation should include '+detail);
 assert.doesNotMatch(routePlan,/单机载重|飞行速度/,'The UAV capacity/speed detail row should stay hidden from the confirmation');
 assert.equal(run(context,'LOGISTICS_CFG.uavKg'),200,'UAV payload capacity should double to 200 kg');
 assert.equal(run(context,'LOGISTICS_CFG.speed.uav'),2.6,'UAV route speed should double to 2.6 km/min');
  for(const [mat,qty] of Object.entries(expected))assert.equal(run(context,`S.logistics.needs.find(m=>m.mat==='${mat}').qty`),qty);
  const beforePause=run(context,'JSON.stringify([S.sim,S.logistics.onHandStock])');
  run(context,'S.paused=true;transportTick();S.paused=false;');
  assert.equal(run(context,'JSON.stringify([S.sim,S.logistics.onHandStock])'),beforePause,'Pause must not move stock or time');
  finish(context);
  assert.equal(run(context,'S.step'),9);assert.equal(run(context,'logisticsQuantityCheck(S.logistics,true).ok'),true);
  const beforeReplay=run(context,'JSON.stringify([S.logistics.onHandStock,S.logistics.handoffStock,S.logistics.delivered,S.logistics.confirmations])');
  run(context,'S.tasks.forEach(t=>{logisticsTaskDeparted(t);logisticsTaskArrived(t);});');
  assert.equal(run(context,'JSON.stringify([S.logistics.onHandStock,S.logistics.handoffStock,S.logistics.delivered,S.logistics.confirmations])'),beforeReplay,'Replayed callbacks must not duplicate stock movements or receipts');
  if(speed===2)defaultReport=report(context);
 }
 const initialReport=defaultReport;
 assert.equal(initialReport.tasks.filter(t=>t.mode==='uav'&&t.finalDelivery).length,4);
 const waveCheck=await setup({speed:2});
 const prepositionCheck=JSON.parse(run(waveCheck,`JSON.stringify((()=>{
  const aircraft=S.tasks.filter(t=>t.preposition),statuses=aircraft.map(t=>t.status);
  aircraft.forEach(t=>t.status='run');const positions=aircraft.map(t=>fbUnitPos(t));
  aircraft.forEach((t,i)=>t.status=statuses[i]);
  return{vehicleNos:aircraft.map(t=>t.vehicleNo),callsigns:aircraft.map(t=>uavCallsign(t,S.tasks.indexOf(t))),positions};
 })())`));
 assert.equal(prepositionCheck.vehicleNos.length,3,'All three UAVs need launch-point preposition flights');
 assert.deepEqual(prepositionCheck.vehicleNos,[1,2,3],'Preposition flights must retain their matching 001/002/003 callsigns');
 assert.deepEqual(prepositionCheck.callsigns,['SC_MY_QS_A003_01','SC_MY_QS_A003_02','SC_MY_QS_A003_03'],'All UAV callsigns must be shown');
 assert.equal(new Set(prepositionCheck.positions.map(p=>JSON.stringify(p))).size,3,'All three launch aircraft must render separately');
 const shuttlePlan=JSON.parse(run(waveCheck,`JSON.stringify((()=>{
  const deliveries=S.tasks.filter(t=>t.finalDelivery&&t.mode==='uav');
  const returns=S.tasks.filter(t=>t.returning);
  return{deliveries:deliveries.map(t=>({id:t.id,vehicleNo:t.vehicleNo,start:t.start,dependsOn:t.dependsOn})),
   returns:returns.map(t=>({id:t.id,vehicleNo:t.vehicleNo,start:t.start,dependsOn:t.dependsOn})),
   aircraft:[...new Set(deliveries.map(t=>t.vehicleNo))]};
 })())`));
 assert.equal(shuttlePlan.aircraft.length,3,'All three UAVs must carry last-mile cargo');
 assert.equal(shuttlePlan.returns.length,shuttlePlan.deliveries.length,'Every loaded trip must be followed by an empty return leg');
 for(const delivery of shuttlePlan.deliveries){
  const back=shuttlePlan.returns.find(t=>t.dependsOn.includes(delivery.id));
  assert.ok(back,delivery.id+' must have an empty return flight');
  assert.equal(back.vehicleNo,delivery.vehicleNo,'The return leg must use the same UAV');
  assert.ok(back.start>=delivery.start,'The UAV cannot return before delivering its load');
 }
 for(const vehicleNo of shuttlePlan.aircraft){
  const deliveries=shuttlePlan.deliveries.filter(t=>t.vehicleNo===vehicleNo).sort((a,b)=>a.start-b.start);
  for(let i=1;i<deliveries.length;i++){
   const previousReturn=shuttlePlan.returns.find(t=>t.dependsOn.includes(deliveries[i-1].id));
   assert.ok(deliveries[i].dependsOn.includes(previousReturn.id),'A UAV must return to the transfer point before its next delivery');
  }
 }
 assert.ok(run(waveCheck,"Math.abs(taskPlaybackDuration(S.tasks.find(t=>t.finalDelivery&&t.mode==='uav'))/taskPlaybackDuration(S.tasks.find(t=>t.mode==='truck'))-.5)<.001"),'UAV movement animation should run at twice the prior speed');
 assert.equal(initialReport.tasks.filter(t=>t.mode==='uav'&&t.finalDelivery).flatMap(t=>t.manifest).filter(m=>m.mat==='medical').reduce((n,m)=>n+m.qty,0),2);
 assert.equal(initialReport.tasks.filter(t=>t.mode==='uav'&&t.finalDelivery).flatMap(t=>t.manifest).filter(m=>m.mat==='hygiene').reduce((n,m)=>n+m.qty,0),20);

 const alternate=await setup({configure:'LOGISTICS_CFG.inventory.P04.hygiene=0;LOGISTICS_CFG.inventory.P04.light=0;'});
 assert.equal(run(alternate,"S.tasks.filter(t=>t.finalDelivery&&t.mode==='uav').flatMap(t=>t.manifest).some(m=>m.mat==='hygiene'&&m.warehouse==='P03')"),true,'UAV loads must follow actual matching, including another warehouse');
 finish(alternate);assert.equal(run(alternate,'S.step'),9);

 const scaled=await setup({people:151});
 assert.equal(run(scaled,"S.tasks.some(t=>t.mode==='team')"),false,'Scaled demand must never create personnel delivery tasks');
 finish(scaled);
 assert.equal(run(scaled,'S.step'),9);assert.ok(run(scaled,'matchedWarehouseIds().length')>=3);
 assert.equal(run(scaled,'S.logistics.needs.length'),6,'The supply plan must not include rescue boats as transfer cargo');

 const shortage=await setup({configure:'Object.values(LOGISTICS_CFG.inventory).forEach(stock=>stock.medical=0);'});
 finish(shortage);
 assert.notEqual(run(shortage,'S.step'),9,'A stock shortage must not announce completed dispatch');
 assert.equal(run(shortage,'S.logistics.quantityCheck.ok'),false);
 assert.equal(run(shortage,'S.logistics.unmet.medical'),2);

 const early=await setup();
 const beforeEarly=run(early,'JSON.stringify([S.logistics.onHandStock,S.logistics.handoffStock,S.logistics.delivered])');
 assert.throws(()=>run(early,'logisticsTaskDeparted(S.tasks.find(t=>t.finalDelivery));'),/数量核对失败/,'Last-mile cargo cannot depart before handoff receipt');
 assert.equal(run(early,'JSON.stringify([S.logistics.onHandStock,S.logistics.handoffStock,S.logistics.delivered])'),beforeEarly);

 const wrongSource=await setup();
 run(wrongSource,"const changed=S.tasks.filter(t=>t.finalDelivery).flatMap(t=>t.manifest).find(m=>m.mat==='water'&&m.warehouse==='P04');changed.warehouse='P03';");
 assert.equal(run(wrongSource,'logisticsQuantityCheck().ok'),false,'Swapping a source warehouse must fail even if global totals match');

 const tampered=await setup();finish(tampered);
 run(tampered,'S.logistics.delivered.water-=1;S.step=8;transportTick();');
 assert.notEqual(run(tampered,'S.step'),9,'A missing receipt must block closure');
 assert.equal(run(tampered,'S.logistics.quantityCheck.ok'),false);

 if(process.argv[2])fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify(defaultReport,null,2)+'\n');
 console.log('PASS: 3 UAVs shuttle all last-mile cargo with empty return legs; no personnel delivery; 200 kg payload and 2x flight speed; 96-person scenario at 1x/2x/4x; 6 materials conserved at every tick; replay, pause, dynamic warehouses, 151-person rounding, shortages, early dispatch and tampered-source/receipt checks.');
 console.log(JSON.stringify({needs:expected,truckBatches:defaultReport.tasks.filter(t=>t.mode==='truck').length,lastMileBatches:defaultReport.tasks.filter(t=>t.finalDelivery).length,emptyUavFlights:defaultReport.tasks.filter(t=>t.returning).length,prepositionFlights:defaultReport.tasks.filter(t=>t.preposition).length,uavFleet:shuttlePlan.aircraft.length,quantityCheck:defaultReport.check.ok}));
})().catch(error=>{console.error(error);process.exitCode=1;});
