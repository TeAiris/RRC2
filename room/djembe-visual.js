// Flow State djembe visual (standalone extract supplied with the project). Unmodified.
export function normalizeDjembeZones(value) {
    const keys = ['bass', 'open', 'slap'], values = keys.map(key => Number.isFinite(value?.[key]) ? Math.max(0, value[key]) : 0), sum = values.reduce((a, b) => a + b, 0);
    if (!sum || !Number.isFinite(sum))
        return { bass: 36, open: 32, slap: 32 };
    const bass = Math.round(values[0] / sum * 1000), open = Math.min(1000 - bass, Math.round(values[1] / sum * 1000));
    return { bass: bass / 10, open: open / 10, slap: (1000 - bass - open) / 10 };
}
/** Transfer radial width to/from adjacent rings, using the far ring only if needed. */
export function resizeDjembeZone(value, zone, percent) {
    const normalized = normalizeDjembeZones(value);
    if (!Number.isFinite(percent))
        return normalized;
    const sizes = { bass: Math.round(normalized.bass * 10), open: Math.round(normalized.open * 10), slap: Math.round(normalized.slap * 10) }, next = Math.round(Math.max(0, Math.min(100, percent)) * 10), delta = next - sizes[zone], neighbors = zone === 'slap' ? ['open', 'bass'] : zone === 'open' ? ['bass', 'slap'] : ['open', 'slap'];
    sizes[zone] = next;
    if (delta <= 0)
        sizes[neighbors[0]] -= delta;
    else {
        let remaining = delta;
        for (const key of neighbors) {
            const transfer = Math.min(sizes[key], remaining);
            sizes[key] -= transfer;
            remaining -= transfer;
        }
    }
    return { bass: sizes.bass / 10, open: sizes.open / 10, slap: sizes.slap / 10 };
}
/** Alternate by the sequencer step, not by note count; rests keep the phase. */
export function djembeStepHalf(step, rightHandLead = false) {
    return Number.isInteger(step) && step >= 0 ? ((step % 2 === 0) !== rightHandLead ? 'left' : 'right') : null;
}
/** Bottom-centered sweep: 180 degrees runs right → bottom → left. */
export function djembeVisualArc(value) { const angle = Number.isFinite(value) ? Math.max(0, Math.min(360, value)) : 360, half = angle * Math.PI / 360; return { angle, start: Math.PI / 2 - half, end: Math.PI / 2 + half }; }
export function clipDjembeSurface(context, cx, cy, radius, angle) { const arc = djembeVisualArc(angle); context.beginPath(); context.moveTo(cx, cy); context.arc(cx, cy, radius, arc.start, arc.end); context.closePath(); context.clip(); }
export function paintDjembeZone(context, cx, cy, outer, inner, color, active, step, pulse, idleOpacity, rightHandLead = false, visualAngle = 360) {
    const arc = djembeVisualArc(visualAngle);
    if (!arc.angle)
        return;
    const selected = djembeStepHalf(step, rightHandLead);
    for (const side of ['left', 'right']) {
        const strength = active && side === selected ? Math.max(0, Math.min(1, pulse)) : 0;
        context.save();
        context.beginPath();
        context.rect(side === 'left' ? cx - outer - 4 : cx, cy - outer - 4, outer + 4, outer * 2 + 8);
        context.clip();
        if (arc.angle < 360)
            clipDjembeSurface(context, cx, cy, outer, arc.angle);
        context.beginPath();
        context.arc(cx, cy, outer, 0, Math.PI * 2);
        if (inner > 0)
            context.arc(cx, cy, inner, Math.PI * 2, 0, true);
        context.fillStyle = color;
        context.globalAlpha = Math.max(0, Math.min(1, idleOpacity + strength));
        context.fill('evenodd');
        context.restore();
    }
}
/** Draw separators once, over the touching zones: no geometry is moved apart. */
export function solidZoneColor(color) { return color.replace(/^#([0-9a-f]{6})[0-9a-f]{2}$/i, '#$1'); }
export function paintDjembeBorders(context, cx, cy, zones, width, visualAngle = 360) {
    const thickness = Number.isFinite(width) ? Math.max(0, Math.min(24, width)) : 0;
    if (!thickness)
        return;
    context.save();
    context.globalAlpha = 1;
    context.lineWidth = thickness;
    const arc = djembeVisualArc(visualAngle);
    for (const zone of zones) {
        if (!arc.angle)
            continue;
        context.strokeStyle = solidZoneColor(zone.color);
        context.beginPath();
        context.arc(cx, cy, zone.outer, arc.start, arc.end);
        if (arc.angle === 360) {
            context.moveTo(cx, cy - zone.outer);
            context.lineTo(cx, cy - zone.inner);
        }
        else
            for (const angle of [arc.start, arc.end]) {
                context.moveTo(cx + Math.cos(angle) * zone.outer, cy + Math.sin(angle) * zone.outer);
                context.lineTo(cx + Math.cos(angle) * zone.inner, cy + Math.sin(angle) * zone.inner);
            }
        context.moveTo(cx, cy + zone.inner);
        context.lineTo(cx, cy + zone.outer);
        context.stroke();
    }
    // The physical rim stays complete even when the playing surface is reduced.
    if (arc.angle < 360 && zones.length) {
        const rim = zones.reduce((a, b) => a.outer > b.outer ? a : b);
        context.strokeStyle = solidZoneColor(rim.color);
        context.beginPath();
        context.arc(cx, cy, rim.outer, 0, Math.PI * 2);
        context.stroke();
    }
    context.restore();
}
export function paintArticulationLabel(context, text, x, y, radius, color, background, outline) {
    context.save();
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = background;
    context.fill();
    context.strokeStyle = solidZoneColor(outline);
    context.lineWidth = 1.5;
    context.stroke();
    context.fillStyle = color;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, x, y);
    context.restore();
}

export const preset = Object.freeze({
  fontFamily: 'sans-serif', fontSize: 20, fontWeight: '400', color: '#ffffff',
  visualAngle: 245.3, zoneBorderWidth: 4.7, rightHandLead: true,
  sensitivity: .3, decay: .12, idleOpacity: .12, showLabels: true,
  labelBackground: '#121a24', bassColor: '#006b3f', toneColor: '#fcd116',
  slapColor: '#ce1126', zoneSizes: Object.freeze({ slap: 32, open: 32, bass: 36 })
});

export function drumReaction(age, duration, sensitivity) {
  return !Number.isFinite(age)||duration<=0?0:Math.max(0,Math.min(1,sensitivity))*Math.max(0,1-age/Math.max(.01,duration));
}

export function strokeToZone(stroke, instrumentType) {
  if (!stroke || stroke === 'rest') return null;
  if (stroke === 'mute' || stroke === 'toneFlam') return 'open';
  if (stroke === 'flam' || stroke === 'slapFlam' || instrumentType === 'bell') return 'slap';
  return stroke === 'tone' || stroke === 'open' ? 'open' : ['bass','slap'].includes(stroke) ? stroke : null;
}

// Draw into a logical 320 × 320 surface; caller owns clearing, scaling and timing.
export function paintDjembe(ctx, settings = preset, { zone = null, step = -1, age = Infinity } = {}) {
  const s = {...preset, ...settings}, cx = 160, cy = 160;
  const sizes = normalizeDjembeZones(s.zoneSizes), bass = 145*sizes.bass/100, open = 145*(sizes.bass+sizes.open)/100;
  const rings = [
    {name:'slap',outer:145,inner:open,color:s.slapColor},
    {name:'open',outer:open,inner:bass,color:s.toneColor},
    {name:'bass',outer:bass,inner:0,color:s.bassColor}
  ].filter(r => r.outer > r.inner);
  const pulse = drumReaction(Math.max(0,age),s.decay,s.sensitivity);
  for(const r of rings) paintDjembeZone(ctx,cx,cy,r.outer,r.inner,r.color,zone===r.name,step,pulse,s.idleOpacity,s.rightHandLead,s.visualAngle);
  paintDjembeBorders(ctx,cx,cy,rings,s.zoneBorderWidth,s.visualAngle);
  const {angle} = djembeVisualArc(s.visualAngle), partial = angle < 360;
  if(!s.showLabels || angle<=0)return;
  ctx.save();
  if(partial)clipDjembeSurface(ctx,cx,cy,145,angle);
  for(const r of rings){
    const centered=r.name==='bass'&&!partial;
    const available=centered?r.outer:(r.outer-r.inner)/2;
    const radius=Math.min(Math.max(12,s.fontSize*.75),available-2);
    if(radius<4)continue;
    ctx.font=`${s.fontWeight} ${Math.min(s.fontSize,radius*1.3)}px ${s.fontFamily}`;
    const offset=centered?0:(r.outer+r.inner)/2;
    paintArticulationLabel(ctx,{bass:'B',open:'O',slap:'X'}[r.name],cx,cy+(partial?offset:-offset),radius,s.color,s.labelBackground,r.color);
  }
  ctx.restore();
}
