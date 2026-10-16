(() => {
  'use strict';
  const $=selector=>document.querySelector(selector);
  const t=window.MSI18N.t;
  const number=()=>new Intl.NumberFormat(window.MSI18N.locale());
  let latestSummary=null, latestHourly=null;

  async function request(path,options={}) {
    const headers={'Content-Type':'application/json',...options.headers};
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),10000);
    let response;
    try {
      response=await fetch(path,{credentials:'same-origin',...options,headers,signal:controller.signal});
    } catch(error) {
      if(error.name==='AbortError')throw new Error(t('error.analyticsTimeout'));
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    let data={};try{data=await response.json();}catch{/* Preserve the status-based error below. */}
    if(!response.ok) {
      const error=new Error(typeof data.detail==='string'?data.detail:t('error.requestIncomplete'));error.status=response.status;throw error;
    }
    return data;
  }

  function comparison(current,previous) {
    if(previous===null||previous===undefined)return t('analytics.noPrevious');
    if(previous===0)return current===0?t('analytics.flat'):t('analytics.previousZero');
    const change=Math.round((current-previous)*1000/previous)/10;
    return t('analytics.change',{value:(change>0?'+':'')+change});
  }

  function svgElement(tag,attributes={},text='') {
    const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);
    if(text)node.textContent=text;return node;
  }

  function renderChart(rows,{target='#trendChart',label=row=>row.day.slice(5).replace('-','/'),showPoints=false}={}) {
    const svg=$(target);svg.replaceChildren();
    const width=800,height=280,left=54,right=22,top=18,bottom=42;
    const plotWidth=width-left-right,plotHeight=height-top-bottom;
    const values=rows.flatMap(row=>[row.pv,row.uv]).filter(Number.isFinite);
    const maximum=Math.max(1,...values);
    const format=number();
    for(let i=0;i<=4;i++) {
      const y=top+plotHeight*i/4,value=Math.round(maximum*(4-i)/4);
      svg.append(svgElement('line',{x1:left,y1:y,x2:width-right,y2:y,class:'chart-grid'}));
      svg.append(svgElement('text',{x:left-9,y:y+4,'text-anchor':'end',class:'chart-axis'},format.format(value)));
    }
    const x=index=>left+(rows.length===1?plotWidth/2:plotWidth*index/(rows.length-1));
    const y=value=>top+plotHeight-(value/maximum)*plotHeight;
    const points=key=>rows.map((row,index)=>({row,index})).filter(item=>Number.isFinite(item.row[key])).map(item=>`${x(item.index)},${y(item.row[key])}`).join(' ');
    for(const [key,lineClass,pointClass,name] of [['pv','chart-pv','chart-pv-point','PV'],['uv','chart-uv','chart-uv-point','UV']]) {
      const linePoints=points(key);
      if(linePoints)svg.append(svgElement('polyline',{points:linePoints,class:lineClass}));
      if(showPoints||rows.length<=14)rows.forEach((row,index)=>{
        if(!Number.isFinite(row[key]))return;
        const point=svgElement('circle',{cx:x(index),cy:y(row[key]),r:3.5,class:pointClass});
        const summary=`${label(row)} · PV ${format.format(row.pv)} · UV ${format.format(row.uv)}`;
        point.setAttribute('tabindex','0');point.setAttribute('aria-label',summary);point.dataset.summary=summary;
        point.append(svgElement('title',{},t('analytics.pointTitle',{label, name, value:format.format(row[key])})));svg.append(point);
      });
    }
    const step=Math.max(1,Math.ceil(rows.length/7));
    rows.forEach((row,index)=>{
      if(index%step&&index!==rows.length-1)return;
      svg.append(svgElement('text',{x:x(index),y:height-16,'text-anchor':'middle',class:'chart-axis'},label(row)));
    });
  }

  // The API only knows Chinese page labels; the locale files carry the translated ones.
  function pageTitle(page) {
    const key = /^chapter-\d+$/.test(page) ? 'chapterTitle.' + page.slice(8).padStart(2, '0') : 'pageName.' + page;
    return window.MSI18N.has(key) ? t(key) : page;
  }

  function renderPages(pages) {
    const body=$('#pagesBody');body.replaceChildren();$('#emptyPages').hidden=pages.length>0;
    const format=number();
    for(const page of pages) {
      const row=document.createElement('tr');
      const title=document.createElement('td');title.textContent=pageTitle(page.page);
      const key=document.createElement('small');key.className='page-key';key.textContent=page.page;title.append(key);
      const pv=document.createElement('td');pv.textContent=format.format(page.pv);
      const uv=document.createElement('td');uv.textContent=format.format(page.uv);
      const share=document.createElement('td');share.textContent=page.share.toFixed(1)+'%';
      row.append(title,pv,uv,share);body.append(row);
    }
  }

  function rangeLabel(data) {
    if(data.range.days===1)return t('analytics.today');
    if(data.range.end===todayInShanghai())return t('analytics.rangeLabelDays',{n:data.range.days});
    return t('analytics.rangeLabelCustom',{start:data.range.start,end:data.range.end});
  }

  function todayInShanghai() {
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const value=type=>parts.find(part=>part.type===type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function render(data) {
    const format=number();
    const label=rangeLabel(data);
    const since=data.lifetime.since?data.lifetime.since.replaceAll('-','/'):t('analytics.enabledDay');
    $('#lifetimePv').textContent=format.format(data.lifetime.pv);$('#lifetimeUv').textContent=format.format(data.lifetime.uv);
    $('#lifetimePvSince').textContent=t('analytics.since',{since});
    $('#lifetimeUvSince').textContent=t('analytics.since',{since});
    $('#todayPv').textContent=format.format(data.today.pv);$('#todayUv').textContent=format.format(data.today.uv);
    $('#rangePvLabel').textContent=t('analytics.rangePvLabel',{label});$('#rangeUvLabel').textContent=t('analytics.rangeUvLabel',{label});
    $('#rangePv').textContent=format.format(data.totals.pv);$('#rangeUv').textContent=format.format(data.totals.uv);
    $('#rangePvCompare').textContent=comparison(data.totals.pv,data.previous?.pv);
    $('#rangeUvCompare').textContent=comparison(data.totals.uv,data.previous?.uv);
    $('#trendRange').textContent=t('analytics.rangeLabelCustom',{start:data.range.start,end:data.range.end});
    $('#updatedAt').textContent=t('analytics.updatedAt',{time:data.updatedAt.replace('T',' '),timezone:data.range.timezone});
    $('#rangeStart').value=data.range.start;$('#rangeEnd').value=data.range.end;
    renderChart(data.daily);renderPages(data.pages);
  }

  function shiftShanghaiDay(offset) {
    const value=new Date(`${todayInShanghai()}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+offset);
    return value.toISOString().slice(0,10);
  }

  function renderHourly(data) {
    const format=number();
    $('#hourlyDate').value=data.date;
    const today=todayInShanghai(),yesterday=shiftShanghaiDay(-1);
    document.querySelectorAll('[data-hour-offset]').forEach(button=>{
      const value=button.dataset.hourOffset==='0'?today:yesterday;
      button.classList.toggle('active',data.date===value);
    });
    $('#hourlyMeta').textContent=`${data.date.replaceAll('-','/')} · PV ${format.format(data.totals.pv)} · UV ${format.format(data.totals.uv)}`;
    if(!data.availableSince) {
      $('#hourlyNote').textContent=t('analytics.hourlyPending');
    } else {
      const since=data.availableSince.slice(0,16).replace('T',' ');
      const firstDay=data.availableSince.slice(0,10);
      const startsAtMidnight=data.availableSince.slice(11,13)==='00';
      $('#hourlyNote').textContent=data.date<firstDay
        ?t('analytics.hourlySinceDay',{since})
        :data.date===firstDay&&!startsAtMidnight?t('analytics.hourlySincePartial',{since}):t('analytics.hourlyNoteUv');
    }
    renderChart(data.hours,{target:'#hourlyChart',label:row=>row.hour,showPoints:true});
    const detail=$('#hourlyDetail');detail.textContent=t('analytics.hourlyDetail');
    document.querySelectorAll('#hourlyChart circle').forEach(point=>{
      const show=()=>{detail.textContent=point.dataset.summary;};
      point.addEventListener('pointerenter',show);point.addEventListener('click',show);point.addEventListener('focus',show);
    });
  }

  async function loadSummary(query='days=7') {
    $('#dashboardStatus').textContent='';
    try {
      const data=await request('/api/analytics/summary?'+query);
      latestSummary=data;render(data);
    } catch(error) {
      $('#dashboardStatus').textContent=error.message;
    }
  }

  async function loadHourly(date=todayInShanghai()) {
    $('#dashboardStatus').textContent='';
    try {
      const data=await request('/api/analytics/hourly?date='+encodeURIComponent(date));
      latestHourly=data;renderHourly(data);
    } catch(error) {
      $('#dashboardStatus').textContent=error.message;
    }
  }

  $('.range-buttons').addEventListener('click',event=>{
    const button=event.target.closest('[data-days]');if(!button)return;
    document.querySelectorAll('[data-days]').forEach(item=>item.classList.toggle('active',item===button));loadSummary('days='+button.dataset.days);
  });
  $('#applyRange').addEventListener('click',()=>{
    const start=$('#rangeStart').value,end=$('#rangeEnd').value;
    if(!start||!end){$('#dashboardStatus').textContent=t('analytics.incompleteRange');return;}
    document.querySelectorAll('[data-days]').forEach(item=>item.classList.remove('active'));
    loadSummary('start='+encodeURIComponent(start)+'&end='+encodeURIComponent(end));
  });
  $('.hourly-buttons').addEventListener('click',event=>{
    const button=event.target.closest('[data-hour-offset]');if(!button)return;
    loadHourly(shiftShanghaiDay(Number(button.dataset.hourOffset)));
  });
  $('#applyHourlyDate').addEventListener('click',()=>{
    const date=$('#hourlyDate').value;
    if(!date){$('#dashboardStatus').textContent=t('analytics.hourlyDateRequired');return;}
    loadHourly(date);
  });
  // Switching language only repaints: numbers, dates and labels follow the new locale.
  window.MSI18N.on(()=>{if(latestSummary)render(latestSummary);if(latestHourly)renderHourly(latestHourly);});
  const today=todayInShanghai();
  for(const input of [$('#rangeStart'),$('#rangeEnd')])input.max=today;
  $('#hourlyDate').max=today;$('#hourlyDate').min=shiftShanghaiDay(-89);
  loadSummary();loadHourly();
})();