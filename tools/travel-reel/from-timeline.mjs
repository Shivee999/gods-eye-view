#!/usr/bin/env node
/**
 * from-timeline.mjs
 *
 * Turns a Google Maps Timeline export into a trip JSON for render.mjs.
 * Visits are clustered into "stops" (places you stayed a while), the travel
 * mode between stops is taken from the recorded activity, and stop names are
 * filled in from the export or, with --geocode, from OpenStreetMap Nominatim.
 *
 *   node tools/travel-reel/from-timeline.mjs --in Timeline.json --days 100 --geocode --out my-trip.json
 *
 * Accepts:
 *   - The phone export (Settings > Location > Timeline > Export) - "Timeline.json"
 *     with a top-level "semanticSegments" array.
 *   - Google Takeout "Semantic Location History" monthly files (pass a folder
 *     or several --in files); these carry place names.
 *
 * Options:
 *   --in         Export file or folder (repeatable)
 *   --out        Output trip JSON                    (default: trip.json)
 *   --days       Keep only the last N days           (default: 100)
 *   --end        Last day to include, YYYY-MM-DD     (default: last day in the export)
 *   --radius     Merge visits closer than this, km   (default: 25)
 *   --min-hours  Minimum stay for a stop             (default: 12)
 *   --title      Video title                         (default: "<N> Days On The Road")
 *   --geocode    Name unnamed stops via Nominatim (1 request/second)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { in: [], out: 'trip.json', days: 100, radius: 25, minHours: 12, geocode: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--in':        opts.in.push(resolve(args[++i])); break;
      case '--out':       opts.out = resolve(args[++i]); break;
      case '--days':      opts.days = parseInt(args[++i], 10); break;
      case '--end':       opts.end = args[++i]; break;
      case '--radius':    opts.radius = parseFloat(args[++i]); break;
      case '--min-hours': opts.minHours = parseFloat(args[++i]); break;
      case '--title':     opts.title = args[++i]; break;
      case '--geocode':   opts.geocode = true; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  if (!opts.in.length) {
    console.error('Pass at least one --in file or folder.');
    process.exit(1);
  }
  return opts;
}

const DAY = 86400000;
const rad = (d) => d * Math.PI / 180;
function km(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// "28.6139°, 77.2090°" or "geo:28.6139,77.2090"
function parseLatLng(s) {
  const m = String(s).match(/(-?\d+(?:\.\d+)?)°?,\s*(-?\d+(?:\.\d+)?)/);
  return m ? { lat: parseFloat(m[1]), lon: parseFloat(m[2]) } : null;
}

const MODE = [
  [/FLY|FLIGHT|PLANE/, 'flight'],
  [/TRAIN|SUBWAY|TRAM|RAIL/, 'train'],
  [/BOAT|FERRY|SAIL/, 'boat'],
  [/WALK|HIK|RUN/, 'walk'],
];
const toMode = (type) => (MODE.find(([re]) => re.test(String(type).toUpperCase())) || [null, 'road'])[1];

function listFiles(paths) {
  return paths.flatMap((p) => (statSync(p).isDirectory()
    ? listFiles(readdirSync(p).map((f) => join(p, f)))
    : p.endsWith('.json') ? [p] : []));
}

// Normalises both export formats into { visits: [...], moves: [...] }.
function readExport(files) {
  const visits = [], moves = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    for (const seg of data.semanticSegments || []) {
      const start = Date.parse(seg.startTime), end = Date.parse(seg.endTime);
      const cand = seg.visit?.topCandidate;
      const ll = cand && parseLatLng(cand.placeLocation?.latLng);
      if (ll) visits.push({ ...ll, start, end });
      if (seg.activity) moves.push({ start, end, mode: toMode(seg.activity.topCandidate?.type) });
    }
    for (const obj of data.timelineObjects || []) {
      const pv = obj.placeVisit, as = obj.activitySegment;
      if (pv?.location?.latitudeE7 != null) {
        visits.push({
          lat: pv.location.latitudeE7 / 1e7, lon: pv.location.longitudeE7 / 1e7,
          start: Date.parse(pv.duration.startTimestamp), end: Date.parse(pv.duration.endTimestamp),
          name: pv.location.name, address: pv.location.address,
        });
      }
      if (as?.duration) {
        moves.push({ start: Date.parse(as.duration.startTimestamp), end: Date.parse(as.duration.endTimestamp), mode: toMode(as.activityType) });
      }
    }
  }
  visits.sort((a, b) => a.start - b.start);
  moves.sort((a, b) => a.start - b.start);
  return { visits, moves };
}

// Consecutive visits within `radius` km become one stop; stops shorter than
// `minHours` are dropped (they are usually transit, meals, fuel stops).
function cluster(visits, radius, minHours) {
  const stops = [];
  for (const v of visits) {
    const last = stops[stops.length - 1];
    if (last && km(last, v) < radius) {
      last.end = Math.max(last.end, v.end);
      last.hours += (v.end - v.start) / 3600000;
      if (!last.name && v.name) last.name = v.name;
      if (!last.address && v.address) last.address = v.address;
    } else {
      stops.push({ ...v, hours: (v.end - v.start) / 3600000 });
    }
  }
  const kept = stops.filter((s) => s.hours >= minHours);
  // Dropping short stops can make neighbours adjacent again, so merge once more.
  const merged = [];
  for (const s of kept) {
    const last = merged[merged.length - 1];
    if (last && km(last, s) < radius) { last.end = s.end; last.hours += s.hours; } else merged.push({ ...s });
  }
  return merged;
}

function modeBetween(moves, a, b) {
  const between = moves.filter((m) => m.start >= a.end - 3600000 && m.end <= b.start + 3600000);
  const rank = ['flight', 'boat', 'train', 'road', 'walk'];
  const found = rank.find((r) => between.some((m) => m.mode === r));
  if (found && found !== 'walk') return found;
  return km(a, b) > 700 ? 'flight' : 'road';
}

async function reverseGeocode(stop) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=en&lat=${stop.lat}&lon=${stop.lon}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'gods-eye-view travel-reel' } });
  if (!res.ok) return;
  const a = (await res.json()).address || {};
  stop.name = a.city || a.town || a.village || a.municipality || a.county || a.state_district || a.state;
  stop.region = a.state || a.country;
}

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

async function main() {
  // Node's fetch only honours HTTPS_PROXY when NODE_USE_ENV_PROXY is set at startup.
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
    });
    child.on('close', (code) => process.exit(code ?? 1));
    return;
  }
  const opts = parseArgs();
  const { visits, moves } = readExport(listFiles(opts.in));
  if (!visits.length) {
    console.error('No visits found in the export.');
    process.exit(1);
  }
  const end = opts.end ? Date.parse(opts.end) + DAY : visits[visits.length - 1].end;
  const start = end - opts.days * DAY;
  const windowed = visits.filter((v) => v.end > start && v.start < end);
  const stops = cluster(windowed, opts.radius, opts.minHours);
  if (stops.length < 2) {
    console.error(`Only ${stops.length} stop(s) found in that window. Try a smaller --min-hours or --radius.`);
    process.exit(1);
  }

  for (const s of stops) {
    if (s.name) {
      s.region = s.address?.split(',').slice(-2, -1)[0]?.trim();
    } else if (opts.geocode) {
      await reverseGeocode(s);
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  const trip = {
    title: opts.title || `${opts.days} Days On The Road`,
    subtitle: `${new Date(Math.max(start, stops[0].start)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} – ${new Date(end - DAY).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`,
    start: isoDay(Math.max(start, stops[0].start)),
    end: isoDay(end - DAY),
    stops: stops.map((s, i) => ({
      name: s.name || `Stop ${i + 1}`,
      region: s.region || '',
      lat: +s.lat.toFixed(5),
      lon: +s.lon.toFixed(5),
      arrive: isoDay(Math.max(s.start, start)),
      ...(i ? { mode: modeBetween(moves, stops[i - 1], s) } : {}),
    })),
  };
  writeFileSync(opts.out, JSON.stringify(trip, null, 2) + '\n');
  console.log(`Wrote ${opts.out}: ${trip.stops.length} stops from ${trip.start} to ${trip.end}`);
  for (const s of trip.stops) console.log(`  ${s.arrive}  ${s.mode || 'start'}\t${s.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
